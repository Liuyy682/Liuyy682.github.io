# Liuyy682 的博客

一个使用 [Astro](https://astro.build/) 构建的极简个人博客，部署于 GitHub Pages。

## 本地运行

需要 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

打开终端输出的本地地址即可预览。生产构建与预览：

```bash
npm run build
npm run preview
```

## 写一篇文章

在 `src/content/blog/` 新建 Markdown 文件，例如 `my-post.md`：

```md
---
title: 文章标题
description: 一句话介绍文章内容。
publishDate: 2026-08-29
updatedDate: 2026-08-30 # 可选
tags: [Astro, 笔记] # 可选
draft: false # 可选，默认为 false
---

从这里开始写正文。
```

文件名会成为文章 URL。生产构建不会发布 `draft: true` 的文章。

## 部署到 GitHub Pages

1. 将仓库命名为 `Liuyy682.github.io`，默认分支设为 `main`。
2. 在仓库 **Settings → Pages → Build and deployment** 中将 Source 设为 **GitHub Actions**。
3. 推送到 `main`。工作流会执行检查、构建，并把 `dist/` 部署至 Pages。

站点地址为 <https://Liuyy682.github.io/>。

## 常用修改位置

- 个人介绍：首页 `src/pages/index.astro` 与关于页 `src/pages/about.astro`
- 站点标题和 SEO 默认值：`src/layouts/BaseLayout.astro`
- 样式：`src/styles/global.css`
- 文章：`src/content/blog/`
