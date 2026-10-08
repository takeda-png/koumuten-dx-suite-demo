# CEPコレクター Worker

工務店DXスイートの「CEPマップ（想起分析）」タブから呼ばれるAPI。会社URLと商圏を受け取り、

- `POST /ceps` … サイトを読み、Claude（Web検索つき）でCEP候補12個と頻度（根拠つき）を生成
- `POST /recall` … CEP文を Claude・Gemini・OpenAI の3エンジンにWeb検索つきで同時に聞き、対象企業が推薦されたかを判定

APIキーはすべてWorker側のシークレットに置く。フロント（GitHub Pages）には鍵を置かない。

## デプロイ（初回）

```bash
cd worker
npm i -g wrangler   # 未導入なら
wrangler login
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put CEP_TOKEN        # 任意の合言葉。タブ側の設定に同じ値を入れる
wrangler deploy
```

出力される `https://cep-collector.<account>.workers.dev` を、タブの「URLから自動収集」→ 設定の **Worker URL** に貼る。トークンも同じ欄に。

## 更新

```bash
wrangler deploy
```

## 費用の目安

1回の収集 ＝ `/ceps` 1回（Claude＋検索4回まで）＋ `/recall` 12〜14回（各3エンジン×検索）。
モデル既定値（Sonnet / gemini-2.5-flash / gpt-5-mini）で数十円〜百数十円程度。モデルは `wrangler.toml` の `[vars]` で変更できる。

## 想起の換算

3エンジン中の登場数 → 自社想起: 0→1, 1→2, 2→4, 3→5。競合想起は最も多く出た1社の登場数を同じ表で換算。
Copilot（Bing）はAPIがないので含めない。手動4エンジン実測（cep-collectorスキル）とは母数が違う点に注意。

## 動作確認

```bash
curl -X POST https://cep-collector.<account>.workers.dev/recall \
  -H 'Content-Type: application/json' -H 'X-CEP-Token: <token>' \
  -d '{"cep":"新卒・中途の求人を出しても応募が来ないとき","company":"シンミドウ","aliases":["sinmido"],"area":"埼玉","target":"sinmido"}'
```
