import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/fitness-coach", async (req, res) => {
  try {
    const message = (req.body.message || "").trim();
    if (!message) return res.status(400).json({ error: "Missing message" });

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
      "The coach couldn't generate a response. Try again.";

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Coach server error. Try again later." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LVLD Nutrition/Fitness Coach API running on port ${port}`);
});
