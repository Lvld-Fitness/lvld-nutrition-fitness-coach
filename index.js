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

// -------------------------------
// âœ… Health check (useful for Render)
// GET /health
// -------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    openaiKeyPresent: !!apiKey,
    hasChatCompletions: typeof client.chat?.completions?.create === "function",
    defaultModel: process.env.MODEL || "gpt-4o-mini",
    visionModel: process.env.VISION_MODEL || "gpt-4o-mini"
  });
});

// -------------------------------
// Helpers
// -------------------------------
const DEFAULT_MODEL = process.env.MODEL || "gpt-4o-mini";
const VISION_MODEL = process.env.VISION_MODEL || "gpt-4o-mini";

function safeText(v) {
  return typeof v === "string" ? v : "";
}

function openAIErrorInfo(err) {
  return {
    status: err?.status || err?.response?.status,
    message: err?.message,
    code: err?.code,
    type: err?.type
  };
}

// ===============================
// Photo â†’ Macro estimate
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

    const completion = await client.chat.completions.create({
      model: VISION_MODEL,
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

      const name = typeof parsed.name === "string" ? parsed.name : "Meal estimate";
      const calories = Number(parsed.calories);
      const protein = Number(parsed.protein);
      const carbs = Number(parsed.carbs);
      const fats = Number(parsed.fats);
      const note = typeof parsed.note === "string" ? parsed.note : "";

      if (!Number.isFinite(calories) || !Number.isFinite(protein) || !Number.isFinite(carbs) || !Number.isFinite(fats)) {
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
      return res.status(500).json({ error: "Failed to parse AI response", raw });
    }
  } catch (err) {
    console.error("nutrition-image server error:", openAIErrorInfo(err));
    return res.status(500).json({ error: "Server error" });
  }
});

// ===============================
// âœ… Dedicated endpoints (match iOS)
// POST /api/workout-coach  -> { messages, availableExercises }
// POST /api/nutrition-coach -> { message }
// ===============================
app.post("/api/workout-coach", async (req, res) => {
  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const availableExercises = Array.isArray(body.availableExercises) ? body.availableExercises : [];

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
      { "name": "Exercise name", "sets": 3, "reps": 10, "restSeconds": 60 }
    ]
  }
}

Rules:
1) The FIRST exercise in plan.exercises MUST be a treadmill walk warm-up:
   - name: "Treadmill walk"
   - sets: 1
2) Return ONLY this JSON object.
`.trim();

    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...chatHistory],
      max_tokens: 700,
      temperature: 0.7
    });

    const raw = completion.choices[0]?.message?.content?.trim() || "";

    let reply = raw;
    let plan = null;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.reply === "string") reply = parsed.reply;
        if (parsed.plan) plan = parsed.plan;
      }
    } catch (e) {
      console.error("Failed to parse workout JSON:", e, raw);
      reply = raw || "I couldn't generate a structured workout right now. Try again in a moment.";
      plan = null;
    }

    return res.json({ reply, plan });
  } catch (err) {
    console.error("Workout coach error:", openAIErrorInfo(err));
    return res.status(500).json({
      reply: "The workout coach ran into a server error. Please try again in a little bit.",
      plan: null
    });
  }
});

app.post("/api/nutrition-coach", async (req, res) => {
  try {
    const body = req.body || {};
    const message = safeText(body.message).trim();
    if (!message) {
      return res.status(400).json({ reply: "Please send a non-empty message.", macros: null });
    }

    const systemPrompt = `
You are the LVLD Nutrition & Fitness Coach.
- Help with macros, weight gain, fat loss, and performance.
- When the user is clearly asking for daily macro targets, respond as JSON:

{
  "reply": "Short explanation of the targets in plain text.",
  "macros": { "calories": 2500, "protein": 180, "carbs": 230, "fats": 70 }
}

- If they are NOT asking for specific targets, respond as:

{ "reply": "Normal helpful answer...", "macros": null }

Return ONLY JSON. No markdown, no backticks.
`.trim();

    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      max_tokens: 500,
      temperature: 0.7
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
      reply = raw || "I wasn't able to come up with a response. Try again in a moment.";
      macros = null;
    }

    return res.json({ reply, macros });
  } catch (err) {
    console.error("Nutrition coach error:", openAIErrorInfo(err));
    return res.status(500).json({
      reply: "The nutrition coach ran into a server error. Please try again in a little bit.",
      macros: null
    });
  }
});

// ===============================
// Legacy route (keeps old iOS builds working)
// ONE route for BOTH workout + nutrition coaches
// POST /fitness-coach
// ===============================
app.post("/fitness-coach", async (req, res) => {
  const body = req.body || {};

  const hasWorkoutHistory = Array.isArray(body.messages);
  const hasSimpleMessage = typeof body.message === "string";

  try {
    if (hasWorkoutHistory) {
      req.url = "/api/workout-coach";
      return app._router.handle(req, res, () => {});
    }

    if (hasSimpleMessage) {
      req.url = "/api/nutrition-coach";
      return app._router.handle(req, res, () => {});
    }

    return res.status(400).json({
      reply:
        "Invalid request format for LVLD coach. Send either { message } or { messages, availableExercises }."
    });
  } catch (err) {
    console.error("LVLD coach server error:", openAIErrorInfo(err));
    return res.status(500).json({
      reply: "The LVLD coach ran into a server error. Please try again in a little bit."
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LVLD Nutrition/Fitness Coach API running on port ${port}`);
});
