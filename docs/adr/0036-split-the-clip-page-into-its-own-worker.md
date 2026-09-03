# ADR 0036: 閲覧ページをMCP境界から切り離し、専用Workerへ置く

- ステータス: Accepted（実装済み）
- 日付: 2026-09-03

## 背景

[ADR 0035](0035-icons-and-installable-clip-page.md)でMCP EdgeへWorkers Static Assetsを足したところ、`/clips`が403を返すようになった。

原因はCloudflareの仕様である。

> When a Worker has Static Assets, the internal assets router does not pass `ctx.access` to the user Worker. Access still protects the Worker and its assets, but `ctx.access` is unavailable to the user Worker.
>
> — [Worker script（Static Assetsのルーティング）](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)、[Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

**錠そのものは掛かったままで、壊れたのは「誰が通ったかをアプリが読む」経路だけである。** 403になっていたのは、読めない身元を[ADR 0021](0021-publish-tools-through-mcp-edge.md)の照合が確かめに行って失敗していたためだった。

この注記は「Static Assetsを持つWorker」全体に掛かるので、`run_worker_first`で実行順を変えても直らない。つまりADR 0035の「Static Assetsで配る」とADR 0021の「アプリ内でaudienceと本人emailを照合する」は、同じWorkerでは両立しない。

## 決定

### 用途で境界を2枚に分ける

| Worker | 入口 | 認証 |
| --- | --- | --- |
| **MCP Worker** | `/mcp`だけ | `ctx.access`でaudienceと本人emailを照合（ADR 0021のまま） |
| **Web Worker**（新規） | `/clips`、`/clips/read`、`/clips/dismiss`、アイコン、manifest | hostnameのAccess policyだけ |

Static AssetsはWeb Workerが持つ。MCP Workerには**持たせない。** 持たせた時点で上の照合が常に失敗する。

Access applicationは分け、policyは既存のものを使い回す。applicationを分けると、ブラウザで開くセッション長を、Managed OAuthを通るMCPクライアントと独立に決められる（[ADR 0030](0030-read-only-clip-page-on-the-public-boundary.md)が影響として書いていた結合が解ける）。

### Web Workerは本人を照合しない

Access policyが認証の正本である。アプリ内でメールアドレスを再照合しない。**身元を読めない以上、これは選択ではなく帰結である。**

代わりに、**Accessを通らない別名の入口を作らないことが唯一の錠になる。** `workers.dev`とpreview URLを無効にする。ここを外すと、Accessの掛かっていないhostnameから一覧が丸ごと読める。

アプリ内のHost検証は置かない。到達できるhostnameはAccessを掛けたCustom Domainだけになり、しかも**静的アセットはWorkerを起動せずに配られる**ため、アプリ内の判定はアイコンとmanifestには最初から効かない。同じ扉を守っていない2枚目の錠を置いても、守れるものが増えない。

### 状態を変えるPOSTだけ、Originで止める

Accessの`CF_Authorization`クッキーは、SameSiteの既定値が`None`である（[Authorization cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)）。**他所のサイトへ置かれたformからPOSTされても、ブラウザはこのクッキーを付けて送り、Accessは素通りする。** Accessは「誰か」しか見ないので、CSRFはAccessでは止まらない。片付けのPOSTを守っているのはOrigin検証だけである。

比較相手はリクエスト自身のオリジンにする。CSRFはブラウザがOriginを攻撃者のサイトへ設定してくれる攻撃で、Hostは攻撃者が選べない。**比較相手を設定値として外から与える必要がない。**

### Coreへの窓口を、この面に必要な3つへ限る

Web Worker専用のRPC入口を別に置き、一覧・本文・片付けの3つだけを公開する。片付けは印を付けるだけで、外す操作は出さない（[ADR 0033](0033-dismiss-clips-from-the-web-page.md)）。ツール契約には載せない（ADR 0030）。Coreのsecretとstorage bindingはWeb Workerへ渡さない。Slack受付、Queue、週次ダイジェスト、AI、GitHub、D1、Durable ObjectsはCoreに残る。

### 監査情報の受け渡しをやめる

ADR 0021の「監査用の`source`と`user_uuid`をRPC引数として渡す」と、ADR 0030の「`source`に`web`を足す」を取り消す。

**渡した値はどこにも記録されていなかった。** 受け取って、空でないことを確かめて、捨てていた。監査と名前が付いていただけで、監査していない。入口が分かれた今、どの境界から来たかは窓口そのものが表す。

## 検討した代替案

- **`run_worker_first`で直す**: 設定1つで済む。ただし上の注記はStatic Assetsを持つWorker全体に掛かるので、実行順を変えても`ctx.access`は渡らない。
- **アセットをbinding経由でWorkerから返す**: `ctx.access`は戻る。ADR 0035が既に退けた形で、hostnameのAccessで保護済みの静的ファイルにWorker呼び出しと境界コードを足すことになる。
- **1つのAccess applicationに2つのhostnameを載せる**: 手作業が減る。セッション長がMCPクライアントと共通のまま残るので採らない。
- **Web WorkerにもHost検証を置く**: 一見で堅い。守る扉が無く、アセットには効かない。
- **監査情報を残す**: 「将来使うかもしれない」。使っていないものを、使っていない形のまま運ぶことになる。必要になったときは、記録する先を決めるところから始める。

## 影響

- Workerが3つになり、Custom Domain、Access application、Workers BuildsのGit接続が1式増える。**ADR 0030が3つ目のWorkerを避けた理由がこの手作業そのもので、その判断を覆す。** アセットを配る面と、身元を読む面が同居できない以上、畳んだままにはできない。
- deploy順はCoreが先、MCPとWebが後。この依存は変わらない。
- Web側の錠はAccess applicationの設定1枚だけになる。設定を外す、あるいはpolicyを緩めると、アプリ側には二重の歯止めが無い。
- `MCP_HOSTNAME`という名前が実態と合うようになる（ADR 0030で「ズレる」と書いた影響が解消する）。
- MCP境界のテストから閲覧ページの検証が消え、Web境界のテストへ移る。
