/*
 * Secure Claude call. Runs on Netlify's server, so the API key stays in a server
 * environment variable and NEVER reaches the browser.
 *
 * The browser POSTs { system, prompt, image?, max_tokens? } to /.netlify/functions/ai
 * and gets back { text }. One function covers every AI feature in the app:
 *   - report drafting / paragraph-from-notes  -> send system + prompt
 *   - reading a survey photo                   -> also send image {data, media_type}
 *
 * Set the key once in Netlify: Site settings -> Environment variables -> ANTHROPIC_API_KEY
 */
import Anthropic from "@anthropic-ai/sdk";

// reads ANTHROPIC_API_KEY from the environment. maxRetries lets the SDK ride
// through transient 429/500/529 "overloaded" blips with its own backoff.
const client = new Anthropic({ maxRetries: 4 });

export default async (req) => {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (req.method !== "POST") return cors(json({ error: "POST only" }, 405));
  if (!process.env.ANTHROPIC_API_KEY) {
    return cors(json({ error: "ANTHROPIC_API_KEY is not set on the server." }, 500));
  }

  let body;
  try { body = await req.json(); } catch { return cors(json({ error: "Invalid JSON body" }, 400)); }

  const { system, prompt, image, max_tokens } = body || {};
  if (!prompt) return cors(json({ error: "Missing 'prompt'" }, 400));

  // Build the user turn: optional image first (Claude can read the photo), then the text.
  const content = [];
  if (image && image.data && image.media_type) {
    content.push({ type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } });
  }
  content.push({ type: "text", text: prompt });

  try {
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: Math.min(Math.max(parseInt(max_tokens, 10) || 4000, 256), 16000),
      thinking: { type: "adaptive" },
      system: system || undefined,
      messages: [{ role: "user", content }],
    });

    if (msg.stop_reason === "refusal") {
      return cors(json({ error: "The request was declined by the safety system." }, 422));
    }
    const text = (msg.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return cors(json({ text }));
  } catch (e) {
    return cors(json({ error: e?.message || "Claude call failed" }, 502));
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function cors(res) {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-allow-methods", "POST, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  return res;
}
