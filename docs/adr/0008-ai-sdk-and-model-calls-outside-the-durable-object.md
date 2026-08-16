# ADR 0008: AI SDKに乗せ、モデルの呼び出しをDurable Objectの外へ出す

- ステータス: Accepted
- 日付: 2026-08-16

## 背景

[ADR 0006](0006-agent-with-save-tool.md) と [ADR 0007](0007-thread-history-in-durable-object.md) の実装として、AI GatewayのOpenAI互換エンドポイントを生の `fetch` で叩き、応答から `tool_calls` を取り出して組み直し、ツール実行の往復を手書きのループで回していた。end-to-endは一度も成功していない。

失敗の中心はツール呼び出しの往復にある。Gemini 3系は `functionCall` に thought signature を付けて返し、次のリクエストでそれをそのまま送り返すことを要求する。送り返さないとHTTP 400になる。応答を自前でパースして組み直す実装は、この「そのまま」を自分で保証し続けることになり、OpenAI互換層では非標準の `extra_content` という経路でしか運べない。Google自身も、公式SDKを使わずに履歴を組み立てる場合は自分で扱う必要があると書いている。

同じ性質の不整合は、`content` を持たないassistantメッセージ、引数のJSON文字列とオブジェクトの揺れ、といった形でも出ていた。プロバイダの応答形式に追随する部分を自作している限り、修正は継ぎ足しになる。

もう一点、モデルの呼び出しを `ThreadAgent`（Durable Object）の中で回していたことで、本来不要な自作が2つ増えていた。DOのRPC境界を越えると `ClipError` のクラス情報が落ちるため失敗を値で運ぶ `TurnOutcome` が要り、`await` をまたぐ処理の交錯を防ぐために自前のPromiseキューが要った。どちらも、モデルの呼び出しがDOの中にあることだけが理由だった。

## 決定

- **Vercel AI SDK（`ai` と `@ai-sdk/google`）を使う。** `generateText` に `tools` と `stopWhen: stepCountIs(5)` を渡してツールの往復を回し、返る `responseMessages` をそのまま会話へ追記する。応答のパース、ツールループ、メッセージ型の定義は持たない。
- **Geminiはネイティブの `generateContent` 形式で呼ぶ。** thought signatureは `providerOptions.google.thoughtSignature` として往復し、JSONで永続化しても保たれる。OpenAI互換エンドポイントは使わない。
- **AI Gatewayは残す。** `@ai-sdk/google` の `baseURL` をGoogle AI Studioのパススルー（`.../{account}/{gateway}/google-ai-studio/v1beta`）へ向ける。GeminiのキーはStored Keys（BYOK）のままゲートウェイ側にあるので、`cf-aig-authorization` だけで認証が通る。providerが必須にしている `apiKey` にはプレースホルダを渡し、送信される `x-goog-api-key` ヘッダーは落とす。
- **モデルの呼び出しはQueue consumer側で行う。** `ThreadAgent` は会話の読み書きだけを持つ。RPC境界を越えるのは会話のJSONだけになり、失敗は普通の例外としてconsumerまで届く。`TurnOutcome` と自前のPromiseキューは削除する。
- **同じスレッドの2通が並走しないよう、consumerを `max_concurrency: 1` にする。** DO内の直列化を、Queueの消費を絞ることで置き換える。
- **ツールの失敗はすべてツール結果としてモデルへ返す。** AI SDKは `execute` の例外を tool-error に変えてループを続けるため、投げてもQueueの再試行には乗らない。一時的な失敗と恒久的な失敗を区別せず、`{ saved: false, failed_at }` として返す。
- **モデル呼び出しの短い再試行はAI SDKの既定（2回、2秒→4秒）に任せ、Queueの再試行はその外側に残す。** 2つは役割が違う。Geminiが混雑で返す503は数秒で回復することが多く、Queueの30秒からのバックオフでは間隔が粗すぎる。逆にゲートウェイ障害のような尾を引く失敗は、AI SDKの数秒では足りない。

## 検討した代替案

- **`ai-gateway-provider`（コミュニティプロバイダ）を使う**: CloudflareのドキュメントがVercel AI SDKとの連携として案内している方式。複数プロバイダのフォールバックが要るなら利点がある。ただしプロバイダを1枚多く挟むぶん、BYOKでの認証の通し方がその実装に依存する。今はモデルが1つで、`baseURL` の差し替えだけで足りる。
- **OpenAI互換エンドポイントを、AI SDKの `@ai-sdk/openai-compatible` で叩く**: モデルの差し替えが容易になるという当初の狙い（README）を保てる。ただしthought signatureは互換層では `extra_content` という非標準の経路に載り、まさにそこで壊れていた。プロバイダ固有の要求を無くすのではなく、見えにくくするだけになる。
- **モデルの呼び出しをDOの中に残す**: RPC境界を越えないため、直列化がDOの中で閉じる。ただし `TurnOutcome` と自前のPromiseキューが要り続ける。消せる自作が2つある方を採る。
- **Cloudflare Agents SDKを採用する**: [ADR 0007](0007-thread-history-in-durable-object.md) と同じ理由で見送る。中心にあるWebSocketでのクライアント同期の利得が、Slackがクライアントであるこのアプリには無い。
- **一時的なツール失敗だけ、`generateText` の後に判定して投げ直す**: Queueの再試行に乗せられる。ただし失敗の種類をツール実行の外へ運ぶ仕組みを自作することになり、消したはずの `TurnOutcome` と同じ形のものが戻ってくる。

## 影響

- **Queueの処理が全体で1本になる。** `max_concurrency: 1` はスレッド単位ではなくconsumer全体に効く。[ADR 0007](0007-thread-history-in-durable-object.md) がD1案を却下した理由の一つを、ここでは受け入れている。単一ユーザーのDMという前提では、待ち時間の増加は問題にならない。並行処理が必要になったら、DO内でモデルを呼ぶ形へ戻すか、スレッド単位のロックを別に用意する。
- **記事取得の一時的な失敗が、自動では取り直されなくなる。** モデルが「取れなかった」と返して1ターンが終わる。取り直すかどうかはユーザーが決める。Queueの再試行が効くのは、モデルの呼び出し自体が失敗した場合とSlackへの投稿が失敗した場合になる。
- **会話履歴の形式がAI SDKの `ModelMessage` になる。** OpenAI互換形式で書かれた既存の履歴は読めない。本番はend-to-endに一度も成功していないため移行対象の会話は無いが、DOに壊れたレコードが残っている場合は消す必要がある。
- **依存が3つ増える**（`ai`、`@ai-sdk/google`、`zod`）。バンドルはgzipで約243 KiB。Workersの上限には十分収まる。
- **モデルの差し替えにコード変更が要る場合がある。** `AI_MODEL` bindingでGeminiの中では差し替えられるが、他社のモデルへ移るときは `@ai-sdk/*` のプロバイダを足すことになる。READMEにあった「プロバイダ固有SDKに依存しない」という方針は、AI SDKのプロバイダ層に依存する形へ変える。
- **AI Gatewayのログは引き続き取れる。** パススルー経由でもゲートウェイを通るため、プロンプトと応答の記録は変わらない。
- **再試行が2段になり、最終的に諦めるまでの時間が延びる。** 当初はQueueへ一本化する（`maxRetries: 0`）と決めたが、本番の初回運用でGeminiが `503 UNAVAILABLE`（"This model is currently experiencing high demand"）を連続して返し、Queueの再試行3回を使い切って4回目でようやく通った。瞬間的な混雑で長い間隔の再試行枠を消費してしまうため、短い再試行を戻した。
