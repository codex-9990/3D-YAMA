# 3D YAMA · Trail Diorama

GPXと写真をブラウザ内で読み込み、実際の標高データを使った3Dジオラマとして眺める静的Webアプリです。

## 機能

- 須磨アルプスの公開地図データによる約919 mのサンプル
- ジオラマ・歩行視点・真上表示、ルート再生、標高グラフ
- GPX、地形JSON、保存プロジェクトの読み込み
- 現在地点への写真追加、プロジェクトJSON・ビューアーZIP・画像の保存
- 日本国内の地理院DEM取得（確認ボタンを押した場合のみ）

## ローカル開発

Node.js 22以上とpnpmを使用します。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run check
pnpm run build
pnpm run preview
python3 scripts/verify-suma-data.py
```

表示URLはpreviewコマンドの出力を確認してください。HTMLのダブルクリックによるfile://起動は非対応です。

## GitHub Pages

このリポジトリの `docs/` に配信可能なビルドを保存しています。

1. Settings → Pages → Build and deployment を開く。
2. Sourceで **Deploy from a branch** を選ぶ。
3. Branchを **main**、フォルダを **/docs** にして保存する。
4. GitHubのデプロイ完了後、Pages画面に表示されるURLを開く。

コード更新後は `pnpm run build` で生成した `dist/` の内容を `docs/` へコピーし、`docs/.nojekyll` を残してください。古いハッシュ付きアセットは新ビルドに置き換えます。相対アセットURLのためリポジトリのサブパスでも配信できます。

## データとプライバシー

選んだGPXや写真をアップロードする機能、解析タグ、アカウント登録はありません。読み込み内容はメモリ上にあり、保存しないままページを閉じると失われます。写真は縮小・再エンコードし、元のEXIF情報は引き継ぎません。

地理院DEMの取得を明示的に実行すると、対象地域のタイル番号とIPアドレスが国土地理院に伝わります。GPXファイルや写真自体は送信しません。

保存したJSONやZIPにはルートの座標と追加した写真が含まれます。公開・共有前に位置情報や写っている人を確認してください。配布サンプルは公開地図由来の生成データのみで、個人の行動記録・時刻・写真は含みません。

## データの出典・注意

- 地形: 地理院タイル（標高タイル）を加工して作成。GSI content terms / Public Data License 1.0。
- サンプルルート・山名: © OpenStreetMap contributors / ODbL 1.0。
- 加工手順、出典ID、検証結果、ファイルのハッシュ: `public/data/provenance.json`。
- データのライセンス: `public/data/LICENSES.txt`。
- ランタイムライブラリの著作権表示: `public/THIRD_PARTY_NOTICES.txt`。

ルートは表示確認用の概略サンプルです。実際の歩行記録ではなく、通行可否・危険箇所・現況は未確認です。登山のナビゲーションや安全判断には使用しないでください。地形は地表標高で、橋・階段・植生などを再現しません。

データと第三者ライブラリのライセンスは、それぞれの対象に適用されます。本リポジトリでは独自アプリケーションコードについて別途の再利用ライセンスを指定していません。
