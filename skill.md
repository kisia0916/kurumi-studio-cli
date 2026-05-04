# kurumi-studio-cli skill

`kurumi-studio` の主要 API を AI agent から安全に叩くための CLI スキルです。  
デフォルト接続先は本番環境 `https://kurumi-studio.kigyokusai.com` です。

## 実行方法

```bash
npm run ks-cli -- <command> [options]
```

## グローバルオプション

- `--base-url <url>`: API ベース URL を上書き
- `--session-file <path>`: 認証セッションファイルの保存先を上書き

## 認証

```bash
npm run ks-cli -- auth login --name <name> --password <password>
npm run ks-cli -- auth me
npm run ks-cli -- auth logout
```

## 下書きワークフロー

```bash
npm run ks-cli -- drafts list
npm run ks-cli -- drafts get --kind <project|food|stamp|event> --id <draftId>
npm run ks-cli -- drafts delete --kind <project|food|stamp|event> --id <draftId>
npm run ks-cli -- drafts approve --kind <project|food|stamp|event> --id <draftId>
```

## プロジェクト作成

新規プロジェクトをCLIから作成できます。  
`--approve true` を付けると、作成ドラフトをそのまま承認して本番データ化します（admin権限が必要）。

```bash
npm run ks-cli -- project create --name <name> --description <text> --floor-id <id> --room-name <text> --project-genre <text> --team-name <text> --place-type <FOOD|NONE> [--picture <url>] [--building-id <id>] [--pin-x <0-100> --pin-y <0-100>] [--approve <true|false>]
```

プロジェクト下書き承認時のみピン座標を指定可能:

```bash
npm run ks-cli -- drafts approve --kind project --id <draftId> --pin-x 50 --pin-y 40
```

## フード作成

```bash
npm run ks-cli -- food create --food-place-id <id> --name <name> [--category <MAIN|SUB|DESSERT>] [--price <number>] [--status <AVAILABLE|FEW|SOLDOUT>] [--allergens <a,b,c|json>] [--photo <url>] [--food-index <n>] [--approve <true|false>]
```

## スタンプ作成

```bash
npm run ks-cli -- stamp create --title <title> --project-id <id> --quiz-data <text> --random-key <text> [--index <n>] [--approve <true|false>]
```

## イベント作成

```bash
npm run ks-cli -- event create --title <title> --start-time <HH:mm> --end-time <HH:mm> --event-space-id <id> --event-date-id <id> [--project-id <id>] [--approve <true|false>]
```

## 公開状態

```bash
npm run ks-cli -- site publication-current
npm run ks-cli -- site publication-set --published <true|false>
```

## アカウント管理

```bash
npm run ks-cli -- accounts list
npm run ks-cli -- accounts create --name <name> --password <password> --role <admin|editor>
npm run ks-cli -- accounts delete --id <accountId>
```

## 任意 API 実行

```bash
npm run ks-cli -- request --method <GET|POST|PUT|PATCH|DELETE> --path </api/...> [--body '{"key":"value"}']
```

## 出力形式

すべてのコマンドは JSON で結果を出力します。  
成功時・失敗時ともに `ok` / `status` / `data` を含むため、AI agent が機械的に判定できます。
