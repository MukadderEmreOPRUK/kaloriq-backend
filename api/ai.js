/**
 * ============================================================================
 *  KALORİQ — TEK DOSYA AI SUNUCUSU (Vercel'e deploy edilir)
 * ============================================================================
 *
 *  Bu tek dosya, uygulamanın iki yapay zekâ özelliğinin hepsine bakıyor:
 *    - Fotoğraftan besin analizi
 *    - Yazarak besin arama
 *
 *  Uygulama (App.tsx) buraya her zaman aynı adrese (/api/ai) istek atıyor,
 *  isteğin içindeki "action" alanına göre bu dosya hangi işi yapacağını
 *  anlıyor. Böylece tek bir dosyada iki ayrı özelliği yönetebiliyoruz.
 *
 *  "BURAYI DEĞİŞTİRECEKSİN" — Vercel'de bu ortam değişkenlerinden EN AZ
 *  birini tanımlaman gerekiyor (README'de adım adım anlatılıyor):
 *    GEMINI_API_KEY     → ücretsiz, kredi kartı istemez (önerilen)
 *    ANTHROPIC_API_KEY  → ücretli, daha güçlü model (Claude)
 *  İkisi de tanımlıysa Gemini kullanılır.
 * ============================================================================
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

function resolveProvider() {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

function languageName(code) {
  return { en: "English", tr: "Turkish" }[code] || "English";
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseJsonResponse(raw) {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

/** Guarantees every numeric/string field is actually that type, no matter what the AI returned. */
function sanitizeFoodItem(raw) {
  const num = (v) => (typeof v === "number" && !isNaN(v) ? v : Number(v) || 0);
  const confidence = ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "medium";
  return {
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : "Bilinmeyen besin",
    estimatedGrams: num(raw?.estimatedGrams),
    kcal: num(raw?.kcal),
    protein: num(raw?.protein),
    carb: num(raw?.carb),
    fat: num(raw?.fat),
    confidence,
  };
}

/* ---------------------------------------------------------------------------
 * AI SAĞLAYICI ÇAĞRILARI (Gemini / Anthropic) — bu ikisi arasında geçiş
 * yapmak istersen ekstra bir şey değiştirmene gerek yok, sadece Vercel'deki
 * ortam değişkenini değiştirmen yeterli.
 * ------------------------------------------------------------------------- */

async function callGemini({ system, userText, imageBase64, imageMediaType, maxTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const parts = [];
  if (imageBase64) parts.push({ inline_data: { mime_type: imageMediaType || "image/jpeg", data: imageBase64 } });
  parts.push({ text: userText });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!response.ok) throw new Error(`Gemini API hatası (${response.status}): ${await response.text().catch(() => "")}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini boş yanıt döndürdü (güvenlik filtreleri engellemiş olabilir).");
  return text;
}

async function callAnthropic({ system, userText, imageBase64, imageMediaType, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const content = [];
  if (imageBase64) content.push({ type: "image", source: { type: "base64", media_type: imageMediaType || "image/jpeg", data: imageBase64 } });
  content.push({ type: "text", text: userText });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content }] }),
  });
  if (!response.ok) throw new Error(`Anthropic API hatası (${response.status}): ${await response.text().catch(() => "")}`);
  const data = await response.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Anthropic yanıtında metin bloğu bulunamadı.");
  return textBlock.text;
}

async function callAI(args) {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error("Hiçbir AI sağlayıcısı ayarlanmadı. Vercel'de GEMINI_API_KEY (ücretsiz) veya ANTHROPIC_API_KEY tanımla.");
  }
  const call = provider === "gemini" ? callGemini(args) : callAnthropic(args);
  // AI sağlayıcısı yanıt vermezse istek sonsuza kadar askıda kalmasın diye
  // 20 saniyelik bir üst sınır koyuyoruz — Vercel'in kendi zaman aşımından
  // önce, temiz bir hata mesajıyla dönüyoruz.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("AI sağlayıcısından zamanında yanıt alınamadı (zaman aşımı).")), 20000));
  return Promise.race([call, timeout]);
}

/* ---------------------------------------------------------------------------
 * ÜÇ İŞLEM — her biri kendi prompt'unu (talimatını) hazırlar, callAI'yi çağırır
 * ------------------------------------------------------------------------- */

async function handleAnalyzeFood(body) {
  const { imageBase64, mediaType, language } = body;
  if (!imageBase64) throw new Error("imageBase64 alanı gerekli.");
  const lang = languageName(language);
  const system = `You are a nutrition expert analyzing a food photo. Identify each distinct food item and
estimate a realistic portion (in grams) and its nutrition.

Respond with ONLY a JSON array matching this schema, no other text, no code fences, no markdown:
[{"name": "food name, written in ${lang}", "estimatedGrams": number, "kcal": number, "protein": number, "carb": number, "fat": number, "confidence": "high" | "medium" | "low"}]

Rules: at most 5 items; use "low" confidence when unsure but still estimate; numbers must be real numbers,
never negative; empty array if nothing recognizable; all text in ${lang}.`;

  const raw = await callAI({ system, userText: "Analyze the foods in this photo and return JSON matching the schema.", imageBase64, imageMediaType: mediaType || "image/jpeg", maxTokens: 1024 });
  const parsed = parseJsonResponse(raw);
  const items = Array.isArray(parsed) ? parsed.map(sanitizeFoodItem) : [];
  return { items };
}

async function handleLookupFood(body) {
  const { query, language } = body;
  if (!query || typeof query !== "string") throw new Error("query alanı gerekli.");
  const lang = languageName(language);
  const system = `You are a nutrition database assistant. You'll get free text naming a food and optionally
an amount (e.g. "a slice of watermelon", "200g lentil soup").

Respond with ONLY a single JSON object, no other text, no code fences:
{"name": "food name with amount, written in ${lang}", "estimatedGrams": number, "kcal": number, "protein": number, "carb": number, "fat": number, "confidence": "high" | "medium" | "low"}

Rules: assume a standard serving if no amount given; numbers must be real numbers, never negative;
best-effort estimate with "low" confidence if unsure; all text in ${lang}.`;

  const raw = await callAI({ system, userText: query, maxTokens: 400 });
  return { item: sanitizeFoodItem(parseJsonResponse(raw)) };
}

/* ---------------------------------------------------------------------------
 * VERCEL GİRİŞ NOKTASI — hangi "action" geldiyse ona göre yukarıdaki iki
 * fonksiyondan birine yönlendiriyor.
 * ------------------------------------------------------------------------- */

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Sadece POST destekleniyor." }); return; }

  try {
    const body = req.body || {};
    switch (body.action) {
      case "analyzeFood":
        res.status(200).json(await handleAnalyzeFood(body));
        break;
      case "lookupFood":
        res.status(200).json(await handleLookupFood(body));
        break;
      default:
        res.status(400).json({ error: 'Geçersiz "action" alanı. "analyzeFood" veya "lookupFood" olmalı.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message || "Bilinmeyen hata." });
  }
};
