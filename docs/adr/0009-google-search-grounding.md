# ADR 0009: Web検索はGeminiのGoogle検索グラウンディングで行う

- ステータス: Accepted
- 日付: 2026-08-16

## 背景

README.mdは「Web検索」を初期バージョンに含めないものとして挙げていた。[ADR 0006](0006-agent-with-save-tool.md) でSlackの入力をすべてAIへ渡すようになり、[ADR 0007](0007-thread-history-in-durable-object.md) でスレッドの会話が続くようになった結果、この除外が実際の使い方と合わなくなった。

会話が続けば、保存した記事から離れた質問が出る。「これ今もこの書き方でいいの？」「このライブラリの最新版はいくつ？」のような、モデルの学習時点より後の事実を要求する問いである。検索の手段が無いと、モデルは古い知識で答えるか、答えられないと言うしかない。前者は静かに間違い、後者は会話として使い物にならない。

一方、`ai@7.0.58` / `@ai-sdk/google@4.0.39`（AI SDK v7系）では、かつての `useSearchGrounding` オプションが削除され、検索はprovider-executedなツールとして渡す形に変わっている。取れる手段が変わったため、除外の判断もこの時点で見直す。

## 決定

- Web検索を初期バージョンに含める。README.mdの「初期バージョンに含めないもの」から `Web検索` を外す。
- 検索はGeminiのGoogle検索グラウンディングを使う。`src/tools.ts` の `createTools` が `google_search: google.tools.googleSearch({})` を `save_clip` と並べて返す。ツールのキー名は `google_search` に揃える。`@ai-sdk/google` のドキュメントがそう求めているためで、型の制約ではない（実行時は `tool.id` で解決されるので、キー名を変えても送信内容は変わらない）。
- ツール定義は `src/tools.ts` の1か所に集める。そのためにプロバイダを `createTools(env, receivedAt, google)` へ渡す。`src/chat.ts` はプロバイダの生成と「モデルをどう呼ぶか」だけを持ち、呼び出し側でツールをスプレッド合成しない。新しいソースファイルは作らない。
- `googleSearch({})` は引数なしで呼ぶ。`searchTypes` や `timeRangeFilter` は指定しない。
- 検索を使うかどうかはモデルが決める。アプリ側で質問を分類したり、`toolChoice` で強制したりしない。判断の基準はシステムプロンプトに書く。特に「保存した記事について聞かれたときは検索しない。手元の本文を読む」を明示し、ADR 0007 の「記事は取得し直さない」を検索経由で崩さないようにする。
- `MAX_STEPS = 5` は変更しない。`google_search` はprovider-executedで、`ai@7.0.58` のループ継続条件は `!part.providerExecuted` で絞った呼び出しが残っていることなので、検索はAI SDKのstepを消費しない。Geminiの1回の `generateContent` の中で検索と回答が完結する。
- 出典はアプリで組み立てない。`generateText` の戻り値の `sources` も `providerMetadata.google.groundingMetadata` も読まず、返信に足さない。出典への言及はシステムプロンプトでモデルに書かせ、サイト名や記事名で示させる。URLは貼らせず、自分で組み立てさせもしない。グラウンディングが返すURLは期限付きのリダイレクトURLで実ドメインが読めず、モデルに実URLを作らせればhallucinationになる。
- `webSearchQueries` などをアプリからログへ出すこともしない。AI Gatewayが既にプロンプトと応答本文を記録しており、`groundingMetadata` は応答本文に含まれる。
- システムプロンプトの禁止事項に「検索結果」を加える。グラウンディングで文脈に入るのは第三者の書いたWebテキストであり、ADR 0006 が記事本文について書いたprompt injectionの面が増える。
- `save_clip` との併用はGemini 3世代でのみ成立する。実行時チェックは書かず、`wrangler.jsonc` の `AI_MODEL` へのコメントと `test/chat.test.ts` の回帰テストで守る。テストは、送信されたリクエストの `tools` に `googleSearch` と `save_clip` の `functionDeclarations` が両方あり、`toolConfig.functionCallingConfig.mode` が `VALIDATED` であることを確認する。
- grounded なターンのツール往復も、これまでどおりそのままDurable Objectへ永続化する。間引かない。
- AI Gatewayの `cache_ttl: null`（キャッシュ無効）を維持する。`scripts/setup-ai-gateway.ts` を変えない。

## 検討した代替案

- **Firecrawl や Brave の検索APIを自前のツールにする**: 検索クエリと結果がアプリの手に入り、出典の実URLも得られる。Firecrawlは記事取得で既に使っているのでキーも増えない。ただし検索・取得・要約の各段が別のLLM往復になり、1回の質問でstepを2〜3消費する。`MAX_STEPS` の見直しと、検索結果をどこまで文脈へ入れるかの設計が新たに必要になる。Geminiの側は検索と回答を1回の `generateContent` で終える。個人利用の規模で、この差に見合う利得が無い。
- **`url_context` ツールを使う**: URLを渡すと中身を読んでくれる。ただし本文取得は `save_clip` が既に持っており、こちらは正規化・保存・履歴への残し方まで含めて設計されている（ADR 0005、ADR 0006）。同じ役割の経路を2本持つことになる。
- **検索を使うかどうかをアプリが判定する**: 「最新」「今」のような語で分岐すれば決定的になる。ADR 0006 でURLの有無による分岐をやめたのと同じ理由で採らない。条件が増え続けて破綻する。
- **出典をアプリが組み立てて返信へ足す**: リンクの形式を保証できる。ただしADR 0006 が `formatSuccessReply` / `formatPartialReply` を廃止して「アプリ側で固定文を足したりリンクを組み立てたりしない」と決めており、ここで例外を作れば廃止した構造が別名で戻る。加えて貼れるURLは `vertexaisearch.cloud.google.com/grounding-api-redirect/...` 形式のリダイレクトURLしかなく、実ドメインが読めず期限付きで失効する。
- **`toolChoice` で検索を強制する**: 最新情報が必要な質問での検索漏れが無くなる。ただし雑談や保存済み記事への質問でも検索が走る。ADR 0006 が `save_clip` の強制を退けたのと同じ判断。
- **モデル世代を実行時にチェックして落とす**: 2.x へ落としたときに気づける。ただし `@ai-sdk/google` 内部のモデル判定（`gemini-` で始まり、既知の2.x系・それ以前でないもの）を複製することになり、SDKの更新や `gemini-4` の登場で壊れる。`result.warnings` を自前でログへ出すのも、`ai` が `logWarnings` を既定で有効にしていて `console.warn` へ出るため重複する。

## 影響

- **Gemini 3世代に縛られる。** `@ai-sdk/google` の `prepareTools` は、function toolsとprovider toolsの併用をGemini 3世代でのみ許す。`AI_MODEL` を `gemini-2.5-flash` などに落とすと、`save_clip` の `functionDeclarations` が例外なく捨てられ、warningが出るだけで保存が黙って効かなくなる。`AI_MODEL` bindingで自由にモデルを差し替えられるという前提が、事実上「Gemini 3世代の中で差し替えられる」に狭まる。
- **Gemini APIの有料枠（billing有効化）が前提になる。** [公式の価格表](https://ai.google.dev/gemini-api/docs/pricing) では、Gemini 3.x 系の Grounding with Google Search は無料枠が **Not available**（脚注は「Google AI Studioでなら試せる」）である。無料枠のまま呼ぶと枠ゼロのリソースを叩くことになり、Geminiは429（クォータ超過）を返す。これは待っても回復しない種類の429で、Queueの再試行では抜けられない。billingを有効にした有料枠では、Gemini 3.x 全モデルで共有の **月5,000検索リクエストまで無料、超過後は1,000リクエストあたり$14**。課金の単位は**検索クエリごと**で、1回のプロンプトが複数のクエリを生めばその数だけ数える。2.5以前の**グラウンディングされたプロンプトごと**（1,500 RPD無料、超過後は1,000プロンプトあたり$35）とは単位が違うため、リクエスト数からの見積もりがそのままでは移せない。副次的に、billingを有効にすると通常の入出力トークンも無料枠ではなく従量課金になる。
- **「無料枠で運用する」という選択肢は取れない。** 無料枠でグラウンディングを使うにはGemini 2.5系（無料枠で500 RPDまで無料）へ落とす必要があるが、2.5系では上のとおり `save_clip` との併用が成立せず保存が黙って効かなくなる。無料枠と、保存＋検索の両立は同時に満たせない。**この機能は有料枠を前提にするしかない**というのが結論で、費用が問題になった場合に削るのはモデル世代ではなくグラウンディングそのものになる。
- **Gemini API追加利用規約に完全準拠しない。** 追加利用規約はグラウンディング利用時にSearch Suggestions（`searchEntryPoint.renderedContent`）をそのまま表示することを求めているが、これはHTMLとCSSであり、Slackのmrkdwnにもblock kitにもレンダリングする手段が無い。工夫で満たせる話ではなく、字義どおり満たす方法が存在しない。単一ユーザーのDMで動く個人利用のBotである前提で、未準拠を承知の上で受け入れる。**再検討のトリガーは、このBotを他人へ配布する、複数ユーザーへ開く、Slack以外の公開UIを持つ、のいずれかに達した時点。** そのときは表示手段のあるUIを用意するか、自前の検索APIへ切り替える。
- **検索結果がDurable Objectに残る。** grounded なターンでは、assistantのcontentに `toolName: 'server:google_search'` のtool-call / tool-resultが `providerExecuted: true` と `providerOptions.google.{serverToolCallId, serverToolType, thoughtSignature}` 付きで載る。AI SDKはこれを往復させる前提で作られており（`toResponseMessages` が残し、`convertToGoogleMessages` が復元する）、間引くとthought signatureの整合が崩れる。ADR 0008 で一度踏んだのと同種の地雷なので、`ThreadAgent` はこれまでどおり `ModelMessage` をそのまま追記する。追加利用規約はGrounded Resultsのキャッシュ・再配信・解析を禁じているが、明示的な例外があり、その1つが「エンドユーザーが自分のチャット履歴を閲覧できるようにする目的で、チャット履歴として保存すること」である。`ThreadAgent` への永続化はこの例外の範囲に収まるため、履歴から検索結果を間引く必要は無い。禁じられているのはそれ以外のキャッシュ・再配信なので、AI Gatewayのキャッシュは `cache_ttl: null` で無効のまま維持する。ただしADR 0007 は履歴に保持期限を設けていないため、例外が「チャット履歴として」の範囲に留まり続けるかは、履歴の使い道を広げるときに再確認する論点として残る。
- **検索するかどうかがモデル任せになる。** 保存済み記事への質問で検索してしまえば、ADR 0007 の「記事は取り直さない」がURL取得ではない経路で崩れる。歯止めはシステムプロンプトの1行だけで、型による強制は無い。
- **出典の正確さがモデルに依存する。** サイト名や記事名で言及させるため、間違ったサイト名を書いても検出できない。実URLを検証する手段はアプリに無い。
- **AI Gateway経由でグラウンディングが通るかは未検証。** `google-ai-studio` プロバイダは透過パススルーなので構造上は通るはずだが、Cloudflare側にグラウンディングについての明示的な記載は無い。本番で確認するまでは前提にしない。
- **入力トークンが増える。** 検索結果が会話履歴に残るため、記事本文と同じく以降のターンで毎回入力に乗る（ADR 0007 の同じ影響が対象を増やして続く）。
- 第三者の書いたWebテキストがモデルの文脈へ入る経路が、記事本文に加えて1つ増える。現時点のツールは `save_clip` だけなので実害は小さいが、GitHubを書き換えるツールを足すときの確認フローの必要性はその分だけ強まる。
