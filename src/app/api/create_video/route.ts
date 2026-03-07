/**
 * /api/create_video
 *
 * Converts a Suno MP3 audio + optional album-art image into an MP4 video
 * ready for YouTube upload.  FFmpeg must be installed in the container
 * (see Dockerfile – the `ffmpeg` apt package is installed there).
 *
 * POST body (JSON):
 *   audio_url  {string}  Required. CDN URL of the MP3 (e.g. from Suno).
 *   image_url  {string}  Optional. Album-art URL (JPEG/PNG/WebP).
 *                        When provided it becomes the full-screen background.
 *                        Falls back to a solid forest-green colour if missing.
 *   title      {string}  Optional. Used only for the Content-Disposition header.
 *
 * Response: binary video/mp4  (suitable for n8n "Binary" response mode → YouTube upload)
 */

import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, readFile } from "fs/promises";
import axios from "axios";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function downloadFile(url: string, dest: string, timeoutMs = 60_000) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: timeoutMs,
    headers: { "User-Agent": "Mozilla/5.0 CapyMelodys/1.0" },
  });
  await writeFile(dest, Buffer.from(res.data));
}

async function tryCleanup(...paths: string[]) {
  await Promise.allSettled(paths.map((p) => unlink(p).catch(() => {})));
}

// ─── route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const uid = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const audioPath = `/tmp/${uid}.mp3`;
  const imagePath = `/tmp/${uid}_bg.jpg`;
  const videoPath = `/tmp/${uid}.mp4`;
  let imageReady = false;

  try {
    // ── 1. Parse request ──────────────────────────────────────────────────────
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400, headers: corsHeaders }
      );
    }

    const { audio_url, image_url = "", title = "capymelodys" } = body;

    if (!audio_url || typeof audio_url !== "string") {
      return NextResponse.json(
        { error: "audio_url is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // ── 2. Download audio ─────────────────────────────────────────────────────
    console.log(`[create_video] Downloading audio: ${audio_url}`);
    await downloadFile(audio_url, audioPath);
    console.log(`[create_video] Audio saved to ${audioPath}`);

    // ── 3. Try to download album art (optional) ───────────────────────────────
    if (image_url && image_url.trim()) {
      try {
        console.log(`[create_video] Downloading image: ${image_url}`);
        await downloadFile(image_url, imagePath, 30_000);
        imageReady = true;
        console.log(`[create_video] Image saved to ${imagePath}`);
      } catch (err: any) {
        console.warn(`[create_video] Image download failed (ok): ${err.message}`);
      }
    }

    // ── 4. Build FFmpeg command ───────────────────────────────────────────────
    //  -preset ultrafast + -tune stillimage → fastest encode for static frames
    //  -crf 18 → excellent visual quality (file size ~20–40 MB for 3 min)
    //  -movflags +faststart → YouTube likes this (moov atom at front)
    let ffCmd: string;

    if (imageReady) {
      // Use Suno album art as full-screen background (scale + crop to 1280×720)
      ffCmd = [
        "ffmpeg -y",
        `-loop 1 -i "${imagePath}"`,
        `-i "${audioPath}"`,
        `-vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p"`,
        `-c:v libx264 -preset ultrafast -tune stillimage -crf 18`,
        `-c:a aac -b:a 128k`,
        `-shortest`,
        `-movflags +faststart`,
        `"${videoPath}"`,
      ].join(" ");
    } else {
      // Solid forest-green background (CapyMelodys brand colour)
      ffCmd = [
        "ffmpeg -y",
        `-f lavfi -i "color=c=0x2d5a1b:size=1280x720:rate=1"`,
        `-i "${audioPath}"`,
        `-vf "format=yuv420p"`,
        `-c:v libx264 -preset ultrafast -crf 18`,
        `-c:a aac -b:a 128k`,
        `-shortest`,
        `-movflags +faststart`,
        `"${videoPath}"`,
      ].join(" ");
    }

    // ── 5. Run FFmpeg ─────────────────────────────────────────────────────────
    console.log(`[create_video] Running FFmpeg…`);
    const { stderr } = await execAsync(ffCmd, { timeout: 240_000 });
    if (stderr) console.log(`[create_video] FFmpeg stderr: ${stderr.slice(-500)}`);
    console.log(`[create_video] FFmpeg done → ${videoPath}`);

    // ── 6. Read result and return ─────────────────────────────────────────────
    const videoBuffer = await readFile(videoPath);
    console.log(`[create_video] MP4 size: ${(videoBuffer.length / 1_048_576).toFixed(1)} MB`);

    await tryCleanup(audioPath, imagePath, videoPath);

    const safeName = title.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
    return new NextResponse(videoBuffer, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": videoBuffer.length.toString(),
        "Content-Disposition": `attachment; filename="${safeName}.mp4"`,
        ...corsHeaders,
      },
    });
  } catch (err: any) {
    console.error(`[create_video] Error:`, err);
    await tryCleanup(audioPath, imagePath, videoPath);
    return NextResponse.json(
      { error: err.message ?? "Video creation failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
