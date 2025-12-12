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
- Help the user design practical workouts.
- You know these available exercise names: ${availableExercises.join(", ") || "bodyweight basics"}.
- Answer in clear, friendly text.
- Do NOT return JSON, just plain text workout guidance.
      `.trim();

      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          ...chatHistory
        ],
        max_tokens: 600
      });

      const reply =
        completion.choices[0]?.message?.content?.trim() ||
        "I couldn’t generate a workout right now. Try again in a moment.";

      return res.json({
        reply,
        plan: null
      });
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
