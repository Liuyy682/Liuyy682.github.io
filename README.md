# 耀阳 · 技术手记

个人博客：<https://liuyy682.github.io/>。首页及技术长文从「耀阳 · 技术手记」Sites 站点迁移，保留原站的布局、移动端适配、文章分类、全文搜索、目录和深色模式。使用现有 Astro 构建与 GitHub Pages 自动部署。

## 本地运行

使用 Node.js 22：

```bash
npm ci
npm run dev
```

发布前检查及生产构建：

```bash
npm run build
npm run preview
```

## 更新技术手记

| 内容 | 文件 |
| --- | --- |
| 首页外壳、导航、页脚与 SEO 信息 | `src/pages/index.astro` |
| 首页、项目、个人介绍与交互 | `public/notes/app.js` |
| 6 篇技术长文、标题、分类与标签 | `public/notes/articles.js` |
| 技术手记样式与移动端适配 | `public/notes/style.css` |

技术手记沿用原站的 hash 路由，例如 `/#/article/agent-context`。分享完整链接即可直达文章，刷新不会产生 Pages 404。正文由 JavaScript 渲染；这次迁移保留原有内容格式，尚未将六篇长文转换成 Markdown 或为其生成独立 HTML 页面。

新增手记时在 `articles.js` 的 `articles` 数组添加记录，沿用已有的 `id`、`title`、`category`、`tags`、`date`、`desc`、`icon`、`takeaway`、`sections` 字段。`id` 应唯一且保持稳定，目录与阅读时间会自动生成。`sections` 使用标题与 HTML 正文的二元数组，可参考已有的 `code`、`table`、`reference` 辅助函数。该文件只放作者维护的可信内容，不接受未经处理的外部 HTML。

原站文章标注为 AI 辅助整理的工程长文草稿，本次迁移保留此说明，待作者审阅后自行修改。

## 原有 Markdown 文章

原来的两篇文章继续位于 `src/content/blog/`，地址保持为 `/blog/hello-world/` 和 `/blog/building-with-astro/`。可通过新站页脚的「Markdown 归档」进入。

继续使用 Markdown 写作时，在 `src/content/blog/` 新建文件：

```md
---
title: 文章标题
description: 一句话介绍文章内容。
publishDate: 2026-10-20
tags: [技术, 笔记]
draft: false
---

从这里开始写正文。
```

这些文章会出现在 `/blog/` 归档中，暂不进入技术手记的首页列表和搜索。`draft: true` 的 Markdown 文章不会发布。

## 发布

推送到 `main` 后，`.github/workflows/deploy.yml` 自动执行依赖安装、Astro 检查、构建并部署 `dist/`。部署状态可在仓库 Actions 查看。仓库 Pages 的发布来源应为 GitHub Actions。

GitHub 仓库现在是这个个人博客的维护源；之后在 Sites 中编辑原站不会自动同步到此仓库，反向也不会同步。原 Sites 站点保留，未改动其发布与访问设置。
