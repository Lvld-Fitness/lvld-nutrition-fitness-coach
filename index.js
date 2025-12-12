import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY || process.env.API_KEY;

if (!apiKey) {
  console.error("⚠️ No OpenAI API key found in OPENAI_API_KEY or API_KEY");
}

const client = new OpenAI({ apiKey });

const app = express();
app.use(cors());
app.use(express.json());

// ONE route for BOTH workout + nutrition coaches
app.post("/fitness-coach", async (req, res) => {
  const body = req.body || {};

  const hasWorkoutHistory = Array.isArray(body.messages);       // workout coach
  const hasSimpleMessage = typeof body.message === "string";    // nutrition coach

  try {
    // 🏋️‍♂️ WORKOUT COACH MODE
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

   "Here’s a solid back & biceps session for you today:

   1) Treadmill walk – 5 minutes
   2) Lat Pulldown – 3 x 8–12
   3) Barbell Row – 3 x 8–10
   4) Dumbbell Curl – 3 x 10–12

   Use assisted pull-ups if you can’t hit the reps, control the negative on each rep, and rest about 45–60 seconds between sets. Let me know if you want to change anything!"

   - First line: 1 short sentence overview.
   - Then a numbered list that matches the exercises in "plan" in order.
   - End with 1–3 short coaching tips (form, tempo, rest, substitutions like assisted pull-ups).

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
          "I couldn’t generate a structured workout right now, but here are some ideas.";
        plan = null;
      }

      return res.json({ reply, plan });
    }

    // 🍽 NUTRITION COACH MODE
    if (hasSimpleMessage) {
      const message = body.message.trim();
      if (!message) {
        return res.status(400).json({ reply: "Please send a non-empty message." });
      }

      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "You are the LVLD Nutrition & Fitness Coach. You help with macros, weight gain, fat loss, performance, and training. Keep advice short, practical, and helpful."
          },
          { role: "user", content: message }
        ],
        max_tokens: 500
      });

      const reply =
        completion.choices[0]?.message?.content?.trim() ||
        "I wasn’t able to come up with a response. Try again in a moment.";

      return res.json({ reply });
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
