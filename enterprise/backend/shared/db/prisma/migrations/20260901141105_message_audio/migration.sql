-- CreateTable
CREATE TABLE "message_audio" (
    "message_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "voice" TEXT,
    "origin" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "object_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_audio_pkey" PRIMARY KEY ("message_id","kind")
);

-- AddForeignKey
ALTER TABLE "message_audio" ADD CONSTRAINT "message_audio_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
