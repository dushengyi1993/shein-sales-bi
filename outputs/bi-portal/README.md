# BI Portal 生成目录

本目录只保存运行时生成物，不再把 `index.html`、`data.json` 或 `sections/` 提交到 Git。

- 生产页面由 `scripts/generate_bi_portal.mjs`、`scripts/generate_bi_portal_shell.mjs` 和 section 预热流程生成。
- GitHub release 只保存可重建源码；业务数据、页面快照和 section cache 以云端 PostgreSQL、备份及运行态为准。
- 新部署必须在目标 commit 上重新生成 Portal，不能把仓库里的历史页面快照覆盖到生产。
