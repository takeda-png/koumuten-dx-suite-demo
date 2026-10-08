/**
 * CEPコレクター Worker
 *  POST /ceps    { url, company, area, target }           → { company, aliases, rows:[{axis,name,prev,evidence,note}] }
 *  POST /recall  { cep, company, aliases, area, target }  → { own, comp, engines:{Claude,Gemini,OpenAI}, competitors, evidence }
 *
 * 必要なシークレット: ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, CEP_TOKEN
 * 任意の環境変数:     ANTHROPIC_MODEL, GEMINI_MODEL, OPENAI_MODEL, ALLOW_ORIGIN
 */

const DEFAULTS = {
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
  GEMINI_MODEL: "gemini-2.5-flash",
  OPENAI_MODEL: "gpt-5-mini",
  ALLOW_ORIGIN: "https://takeda-png.github.io",
};
const cfg = (env, k) => env[k] || DEFAULTS[k];

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(env, origin);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (env.CEP_TOKEN && req.headers.get("X-CEP-Token") !== env.CEP_TOKEN) return json({ error: "token" }, 401, cors);

    const url = new URL(req.url);
    let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400, cors); }
    try {
      if (url.pathname === "/ceps") return json(await generateCeps(body, env), 200, cors);
      if (url.pathname === "/recall") return json(await measureRecall(body, env), 200, cors);
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  },
};

function corsHeaders(env, origin) {
  const allow = cfg(env, "ALLOW_ORIGIN").split(",").map(s => s.trim());
  const ok = allow.includes("*") || allow.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : allow[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CEP-Token",
    "Vary": "Origin",
  };
}
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...h } });

/* ---------- 1. CEP候補の生成 ---------- */
async function generateCeps({ url, company, area, target }, env) {
  if (!url && !company) throw new Error("url か company が必要です");
  const site = url ? await fetchSiteText(url) : "";
  const aud = target === "sinmido" ? "工務店・住宅会社の経営者（B2B）" : "注文住宅を検討しはじめる施主（B2C）";
  const seedHint = target === "sinmido"
    ? "採用（応募が来ない・担い手不足）、集客（見学会・HP・SNS・広告）、経営（事業承継・価格転嫁・AI活用）の切り口。全建総連「工務店アンケート調査」など回答数のある業界調査を検索して頻度の根拠にすること。"
    : "ライフイベント（子どもの進学・出産・同居・相続）、住まいの不満（寒い・手狭・賃貸更新）、お金（金利・補助金）、情報接触（展示場・友人・SNS）の切り口。国交省「住宅市場動向調査」やリクルート「注文住宅動向・トレンド調査」など割合の載った調査を検索して頻度の根拠にすること。";

  const prompt = `あなたはCEP（Category Entry Points）分析の専門家です。
対象企業: ${company || "(サイトから読み取る)"}  URL: ${url || "-"}  商圏: ${area || "-"}
顧客: ${aud}
${seedHint}

サイトの主要テキスト（今の訴求を読み取る材料）:
"""
${site.slice(0, 6000)}
"""

やること:
1. 顧客が「このカテゴリーが必要だ」と思い出す場面（CEP）を12個、必ず「〜のとき」で終わる一文で書く。似た場面はまとめる。
2. 各CEPに切り口 axis（When/Who/Why/Where）を付ける。
3. 頻度 prev を1〜5で採点。基準: 5=業界調査で過半数が該当、4=3〜5割、3=1〜3割、2=調査に出ないが現場で聞く、1=ほぼ聞かない。根拠は evidence に「出典名(年): 数字」で書く。根拠が見つからなければ「要確認」と書く。
4. note には、その場面に対して対象企業のサイトが今どんな訴求をしているか（見出し・事例・サービス名）を書く。該当がなければ「（訴求なし）」。
5. aliases に、回答文中で対象企業を照合するための表記ゆれ（社名、カナ、ドメイン、運営メディア名）を配列で。

出力は次のJSONのみ（前後に文章を付けない）:
{"company":"...","aliases":["..."],"rows":[{"axis":"When","name":"〜のとき","prev":4,"evidence":"...","note":"..."}]}`;

  const text = await callClaude(env, prompt, { search: true, maxTokens: 4000 });
  const obj = extractJson(text);
  if (!obj || !Array.isArray(obj.rows)) throw new Error("CEP生成の出力を読めませんでした");
  obj.rows = obj.rows.slice(0, 15).map(r => ({
    axis: ["When","Who","Why","Where"].includes(r.axis) ? r.axis : "When",
    name: String(r.name || "").trim(), prev: clamp(r.prev), own: null, comp: null,
    note: String(r.note || "（訴求なし）"), evidence: String(r.evidence || "要確認"),
  })).filter(r => r.name);
  obj.company = obj.company || company;
  obj.aliases = uniq([company, ...(obj.aliases || [])].filter(Boolean));
  return obj;
}

async function fetchSiteText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (CEP-collector)" }, cf: { cacheTtl: 3600 } });
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || "";
    const heads = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => strip(m[1])).filter(Boolean).slice(0, 60);
    const body = strip(html.replace(/<(script|style|nav|footer)[\s\S]*?<\/\1>/gi, " ")).slice(0, 3000);
    return `TITLE: ${strip(title)}\nDESCRIPTION: ${desc}\nHEADINGS:\n- ${heads.join("\n- ")}\nBODY: ${body}`;
  } catch (e) { return `（サイト取得失敗: ${e.message}）`; }
}
const strip = s => String(s).replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;|&quot;|&#39;|&lt;|&gt;/g, m => ({"&nbsp;":" ","&amp;":"&","&quot;":'"',"&#39;":"'","&lt;":"<","&gt;":">"}[m])).replace(/\s+/g, " ").trim();

/* ---------- 2. 想起の実測（3エンジン並列） ---------- */
async function measureRecall({ cep, company, aliases, area, target }, env) {
  if (!cep || !company) throw new Error("cep と company が必要です");
  const al = uniq([company, ...(aliases || [])].filter(Boolean));
  const scene = String(cep).replace(/。$/, "");
  const q = target === "sinmido"
    ? `${area ? area + "の" : ""}工務店です。${scene}、相談できる会社やサービスを教えてください。`
    : `${scene}。${area ? area + "で" : ""}おすすめの工務店・住宅会社を教えてください。`;
  const tail = `\n\n回答の最後に、推薦した会社・サービス名を順番どおりに次の形式で1行で付けてください: RECOMMENDED_JSON=["A社","B社",...]`;

  const [c, g, o] = await Promise.allSettled([
    callClaude(env, q + tail, { search: true, maxTokens: 1800 }),
    callGemini(env, q + tail),
    callOpenAI(env, q + tail),
  ]);
  const engines = {
    Claude: judge(c, al), Gemini: judge(g, al), OpenAI: judge(o, al),
  };
  const hits = Object.values(engines).filter(e => ["上位","中位","言及"].includes(e.rank)).length;
  const measured = Object.values(engines).filter(e => e.rank !== "—").length;
  // 3エンジン → 1〜5換算（0→1, 1→2, 2→4, 3→5）
  const own = measured === 0 ? null : [1,2,4,5][hits];
  const comp = new Map();
  for (const e of Object.values(engines)) for (const n of new Set(e.recommended)) if (!matchAlias(n, al)) comp.set(n, (comp.get(n) || 0) + 1);
  const top = [...comp.entries()].sort((a, b) => b[1] - a[1])[0];
  const compScore = top ? [1,2,4,5][Math.min(3, top[1])] : 1;
  return {
    query: q, own, comp: compScore, engines,
    competitors: [...comp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => ({ name: n, count: c })),
    evidence: `想起: ${measured}エンジン中${hits}（${Object.entries(engines).filter(([, e]) => ["上位","中位","言及"].includes(e.rank)).map(([k]) => k).join(", ") || "なし"}）` + (top ? ` 競合: ${top[0]}${top[1]}` : ""),
  };
}

function judge(settled, aliases) {
  if (settled.status !== "fulfilled" || !settled.value) return { rank: "—", recommended: [], error: settled.reason ? String(settled.reason.message || settled.reason) : "empty" };
  const text = settled.value;
  const m = text.match(/RECOMMENDED_JSON\s*=\s*(\[[\s\S]*?\])/);
  let rec = []; try { rec = m ? JSON.parse(m[1]).map(String) : []; } catch { rec = []; }
  const idx = rec.findIndex(n => matchAlias(n, aliases));
  let rank = "無し";
  if (idx >= 0 && idx < 3) rank = "上位"; else if (idx >= 0 && idx < 10) rank = "中位"; else if (matchAlias(text, aliases)) rank = "言及";
  return { rank, position: idx >= 0 ? idx + 1 : null, recommended: rec, excerpt: text.replace(/RECOMMENDED_JSON[\s\S]*$/, "").slice(0, 600) };
}
function matchAlias(text, aliases) {
  const t = norm(text); return aliases.some(a => a && t.includes(norm(a)));
}
const norm = s => String(s).toLowerCase().replace(/[\s　・\-‐–—()（）株式会社有限会社]/g, "");

/* ---------- LLM 呼び出し ---------- */
async function callClaude(env, prompt, { search = false, maxTokens = 1500 } = {}) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 未設定");
  const body = { model: cfg(env, "ANTHROPIC_MODEL"), max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json(); if (!r.ok) throw new Error("Claude: " + (j.error?.message || r.status));
  return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}
async function callGemini(env, prompt) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY 未設定");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg(env, "GEMINI_MODEL")}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
  });
  const j = await r.json(); if (!r.ok) throw new Error("Gemini: " + (j.error?.message || r.status));
  return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
}
async function callOpenAI(env, prompt) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY 未設定");
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: cfg(env, "OPENAI_MODEL"), tools: [{ type: "web_search" }], input: prompt }),
  });
  const j = await r.json(); if (!r.ok) throw new Error("OpenAI: " + (j.error?.message || r.status));
  if (j.output_text) return j.output_text;
  return (j.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n");
}

/* ---------- utils ---------- */
function extractJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; }
}
const clamp = v => { v = Number(v); return isFinite(v) ? Math.min(5, Math.max(1, Math.round(v))) : 3; };
const uniq = a => [...new Set(a)];
