# 页间 Between Pages

私人作品拼贴日记。数据只保存在本机浏览器（IndexedDB），没有服务器。

## 开发

```bash
npm install
npm run dev      # 本地开发
npm run build    # 构建到 dist/
```

## 部署

推送到 `main` 分支后，GitHub Actions 会自动构建并发布到 GitHub Pages（见 `.github/workflows/deploy.yml`）。
首次使用需在仓库 Settings → Pages → Build and deployment → Source 中选择 **GitHub Actions**。

## 数据安全

- 数据库结构与版本历史见 `src/db.ts`，升级只能新增 `db.version(n + 1)`，不能删除旧版本声明。
- 「备份与恢复」页可导出全部日记、作品、图片为一个 JSON 文件，并在任意设备上合并恢复。
- 在 iPhone 上建议用 Safari「分享 → 添加到主屏幕」，并从主屏幕图标打开。
