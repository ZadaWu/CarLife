-- M4-06：①Working 的 thread 映射持久化。
--
-- 检查点落 PG 之后还差这一半：没有映射，重启后不知道该读哪个 thread 的检查点，
-- 会出现"检查点在库里但上下文照丢"的假成功。
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "working_thread_id" TEXT;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "working_expires_at" TIMESTAMP(3);
