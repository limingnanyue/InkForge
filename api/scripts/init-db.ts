/**
 * 数据库初始化脚本：创建表 + 内置默认提供商
 */
import { initDb, db, DB_PATH } from '../db.js';

initDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
console.log(`数据库已初始化：${DB_PATH}`);
console.log('表：', tables.map(t => t.name).join(', '));
process.exit(0);
