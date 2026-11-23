# 安卓个人版

书架右上角的「＋」菜单里有「找书与同步」。可以按书名、作者或 ISBN 搜索 Z-Library，浏览中文首页的热门书籍，或者从预置的微信书架批量导入。安卓个人版使用独立包名 `com.bilingify.readest.personal`。

「一键同步」优先选择书架 ISBN 对应的版本。未匹配的书会用作品名和作者搜索，也会单独查作品名。出版年份、版次和宣传语可用于辨认版本，上下册、卷号和套装范围会参与核对。同一作品有多种文件时优先 EPUB。遇到同名作品或分册不明，可展开书目选择候选，也可点「重新匹配并导入」单独查这本书。需要登录或遇到限额时，可在「打开 Z-Library」中检查站点状态，随后继续同步。书籍成功写入 Readest 后才计入已入架。

在「找书与同步」中将「全部书籍」切换为「待匹配」，点「批量匹配」可先查找所有未确认的书。匹配成功后切换到「可导入」，再点「一键同步」下载。

## 打包自己的书架

在个人分支运行 GitHub Actions 的 **Personal Android APK**，下载 `readest-arm64` 构建产物。私有书单和签名留在本机。以下 JSON 是书单的最小格式，`isbn` 为选填。

```json
{
  "version": 1,
  "books": [
    {"id": "example", "title": "Pride and Prejudice", "author": "Jane Austen"}
  ]
}
```

使用 Python 3.11 以上和 Android Build Tools 35 以上将书单加入通用 APK 并签名。后续升级沿用同一签名。

```sh
python3 scripts/personalize-android.py readest-arm64.apk personal-shelf.json Readest-personal.apk \
  --build-tools "$ANDROID_HOME/build-tools/35.0.0" \
  --keystore /path/to/personal.p12 --password-file /path/to/password-file
```
