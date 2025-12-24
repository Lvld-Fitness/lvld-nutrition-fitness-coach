import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY || process.env.API_KEY;

if (!apiKey) {
  console.error("âš ï¸ No OpenAI API key found in OPENAI_API_KEY or API_KEY");
}

const client = new OpenAI({ apiKey });

const app = express();
app.use(cors());

// IMPORTANT: image uploads are base64, so bump body limits
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ===============================
// NEW: Photo â†’ Macro estimate
// POST /nutrition-image
// Body: { imageBase64: "....", ingredientsHint?: string, servings?: number }
// Returns: { name, calories, protein, carbs, fats, note }
// ===============================
app.post("/nutrition-image", async (req, res) => {
  try {
    const { imageBase64, ingredientsHint = "", servings = 1 } = req.body || {};

    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    const servingsNum = Number(servings);
    if (!Number.isFinite(servingsNum) || servingsNum <= 0) {
      return res.status(400).json({ error: "Invalid servings" });
    }

    // If the client sent a data URL, strip to raw base64
    const base64 = imageBase64.includes("base64,")
      ? imageBase64.split("base64,")[1]
      : imageBase64;

    // We send as a data URL so OpenAI can read it as an image
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    const systemPrompt = `
You are the LVLD Nutrition Coach.

Task:
- Estimate TOTAL macros for the meal in the image for the given servings.
- Use the optional user ingredients hints to improve accuracy.
- If the image is unclear, still provide a best-effort estimate and mention uncertainty in "note".

Return STRICT JSON ONLY (no markdown, no backticks):

{
  "name": "short meal name",
  "calories": number,
  "protein": number,
  "carbs": number,
  "fats": number,
  "note": "short note about assumptions/ingredients/uncertainty"
}

Rules:
- calories/protein/carbs/fats MUST be integers.
- Values should be TOTALS for servings = ${servingsNum}.
- Keep note under 160 characters.
`.trim();

    const userText = `
Servings: ${servingsNum}
Ingredients hint: ${String(ingredientsHint).trim() || "none"}
Estimate macros for this meal photo.
`.trim();

    // Vision-capable model: default to gpt-4o-mini unless overridden
    const model = process.env.VISION_MODEL || "gpt-4o-mini";

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ],
      max_tokens: 350,
      temperature: 0.4
    });

    const raw = completion.choices[0]?.message?.content?.trim() || "";

    try {
      const parsed = JSON.parse(raw);

      // Basic shape validation + coercion
      const name = typeof parsed.name === "string" ? parsed.name : "Meal estimate";
      const calories = Number(parsed.calories);
      const protein = Number(parsed.protein);
      const carbs = Number(parsed.carbs);
      const fats = Number(parsed.fats);
      const note = typeof parsed.note === "string" ? parsed.note : "";

      if (
        !Number.isFinite(calories) ||
        !Number.isFinite(protein) ||
        !Number.isFinite(carbs) ||
        !Number.isFinite(fats)
      ) {
        throw new Error("Invalid macro numbers");
      }

      return res.json({
        name,
        calories: Math.round(calories),
        protein: Math.round(protein),
        carbs: Math.round(carbs),
        fats: Math.round(fats),
        note
      });
    } catch (e) {
      console.error("Failed to parse nutrition-image JSON:", e, raw);
      return res.status(500).json({
        error: "Failed to parse AI response",
        raw
      });
    }
  } catch (err) {
    console.error("nutrition-image server error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ONE route for BOTH workout + nutrition coaches
app.post("/fitness-coach", async (req, res) => {
  const body = req.body || {};

  const hasWorkoutHistory = Array.isArray(body.messages);       // workout coach
  const hasSimpleMessage = typeof body.message === "string";    // nutrition coach

  try {
    // ðŸ‹ï¸â€â™‚ï¸ WORKOUT COACH MODE
    if (hasWorkoutHistory) {
      const messages = body.messages;
      const availableExercises = body.availableExercises || [];

      const chatHistory = messages.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content || m.text || ""
      }));

  const systemPrompt = `
You are the LVLD Workout Coach.

Your job:
- Design practical strength workouts based on the conversation.
- Always include a short treadmill warm-up as the FIRST exercise.
- Use ONLY these exercise names when possible: ${availableExercises.join(", ") || "basic bodyweight moves"}.
- Keep things realistic for a normal gym.

You MUST respond as STRICT JSON, no markdown, no backticks.

JSON format:

{
  "reply": "short multi-line description of the workout",
  "plan": {
    "restSeconds": number | null,
    "exercises": [
      {
        "name": "Exercise name",
        "sets": 3,
        "reps": 10,
        "restSeconds": 60
      }
    ]
  }
}

Rules:

1) The FIRST exercise in plan.exercises MUST be a treadmill walk warm-up:
   - name: "Treadmill walk"
   - sets: 1

2) "reply" should be friendly and readable text, like:

   "Hereâ€™s a solid back & biceps session for you today:

   1) Treadmill walk â€“ 5 minutes
   2) Lat Pulldown â€“ 3 x 8â€“12
   3) Barbell Row â€“ 3 x 8â€“10
   4) Dumbbell Curl â€“ 3 x 10â€“12

   Use assisted pull-ups if you canâ€™t hit the reps, control the negative on each rep, and rest about 45â€“60 seconds between sets. Let me know if you want to change anything!"

   - First line: 1 short sentence overview.
   - Then a numbered list that matches the exercises in "plan" in order.
   - End with 1â€“3 short coaching tips (form, tempo, rest, substitutions like assisted pull-ups).

3) "plan.exercises" must match the list in "reply":
   - Same order.
   - Same exercise names.
   - For treadmill warm-up, just keep sets: 1, reps: 5.

Return ONLY this JSON object.
  `.trim();


      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          ...chatHistory
        ],
        max_tokens: 700,
        temperature: 0.7
      });

      const raw = completion.choices[0]?.message?.content?.trim() || "";

      let reply = raw;
      let plan = null;

      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.reply === "string") {
            reply = parsed.reply;
          }
          if (parsed.plan) {
            plan = parsed.plan;
          }
        }
      } catch (e) {
        console.error("Failed to parse workout JSON:", e, raw);
        // fallback: use raw text as reply, no plan
        reply =
          raw ||
          "I couldnâ€™t generate a structured workout right now, but here are some ideas.";
        plan = null;
      }

      return res.json({ reply, plan });
    }

// ðŸ½ NUTRITION COACH MODE
if (hasSimpleMessage) {
  const message = body.message.trim();
  if (!message) {
    return res.status(400).json({ reply: "Please send a non-empty message.", macros: null });
  }

  const systemPrompt = `
You are the LVLD Nutrition & Fitness Coach.
- Help with macros, weight gain, fat loss, and performance.
- When the user is clearly asking for daily macro targets, respond as JSON:

{
  "reply": "Short explanation of the targets in plain text.",
  "macros": {
    "calories": 2500,
    "protein": 180,
    "carbs": 230,
    "fats": 70
  }
}

- If they are NOT asking for specific targets, respond as:

{
  "reply": "Normal helpful answer...",
  "macros": null
}

Return ONLY JSON. No markdown, no backticks.
  `.trim();

  const completion = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ],
    max_tokens: 500
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "";

  let reply = raw;
  let macros = null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.reply === "string") reply = parsed.reply;
      if (parsed.macros) macros = parsed.macros;
    }
  } catch (e) {
    console.error("Failed to parse nutrition JSON:", e, raw);
    reply = raw || "I wasnâ€™t able to come up with a response. Try again in a moment.";
    macros = null;
  }

  return res.json({ reply, macros });
}


    // Bad payload
    return res.status(400).json({
      reply:
        "Invalid request format for LVLD coach. Send either { message } or { messages, availableExercises }."
    });
  } catch (err) {
    console.error("LVLD coach server error:", err);
    return res.status(500).json({
      reply: "The LVLD coach ran into a server error. Please try again in a little bit."
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LVLD Nutrition/Fitness Coach API running on port ${port}`);
});
