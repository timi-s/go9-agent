import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Prisma CLI 配置（在 server 目录执行 prisma 命令时自动加载）。
// 注意：SQLite 相对路径以本配置文件所在目录（server/）为基准解析，
// 因此 `file:./dev.db` 指向 server/dev.db，与运行时 src/db.js 的默认绝对路径一致。
// 可用 DATABASE_URL 覆盖（与运行时共用同一变量）。
const databaseUrl = process.env.DATABASE_URL?.trim() || 'file:./dev.db'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: databaseUrl },
})
