#!/usr/bin/env node
'use strict';

// Opt-in narration production. Only the authored narration text is sent to
// Deepgram. The API credential enters over stdin and is never saved or logged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const source = path.resolve(process.argv[2] || 'output/demo/2026-09-12T08-04-31-794Z');
const output = path.join(source, 'deepgram');
const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const ffprobe = '/opt/homebrew/bin/ffprobe';
const model = 'aura-2-thalia-en';
const prior = JSON.parse(fs.readFileSync(path.join(source, 'render-report.json'), 'utf8'));
const segments = prior.segments.map(({ start, end, text }) => ({ start, end, text }));

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function probe(file) {
  return JSON.parse(run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
}
function stamp(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function wrap(text) {
  const lines = [];
  for (const word of text.split(/\s+/)) {
    const last = lines.length - 1;
    if (last < 0 || lines[last].length + word.length + 1 > 62) lines.push(word);
    else lines[last] += ` ${word}`;
  }
  return lines.join('\n');
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  let credential = '';
  for await (const chunk of process.stdin) {
    credential += chunk.toString();
    if (credential.length > 1024) throw new Error('Invalid credential input');
    if (credential.includes('\n')) break;
  }
  credential = credential.trim();
  assert.ok(credential, 'Supply the Deepgram credential over stdin');
  const url = new URL('https://api.deepgram.com/v1/speak');
  url.search = new URLSearchParams({model, encoding: 'linear16', container: 'wav', sample_rate: '24000'}).toString();
  try {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      segment.audio = path.join(output, `narration-${String(i + 1).padStart(2, '0')}.wav`);
      const receiptPath = segment.audio + '.json';
      if (fs.existsSync(segment.audio) && fs.existsSync(receiptPath)) {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.text, segment.text, 'Cached narration must match the script');
        assert.equal(receipt.model, model);
      } else {
        assert.ok(!fs.existsSync(segment.audio), 'An unverified output exists; inspect it before continuing');
        const response = await fetch(url, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `Token ${credential}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({text: segment.text}), signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error(`Deepgram synthesis failed: HTTP ${response.status}. No fallback was used.`);
        const audio = Buffer.from(await response.arrayBuffer());
        assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
        assert.equal(audio.subarray(8, 12).toString(), 'WAVE');
        fs.writeFileSync(segment.audio, audio, {flag: 'wx'});
        fs.writeFileSync(receiptPath, JSON.stringify({provider: 'Deepgram', model, text: segment.text, bytes: audio.length}, null, 2), {flag: 'wx'});
      }
      segment.sourceDuration = Number(probe(segment.audio).format.duration);
      assert.ok(segment.sourceDuration > 1);
      segment.tempo = Math.max(1, segment.sourceDuration / (segment.end - segment.start));
      assert.ok(segment.tempo <= 1.25, `Segment ${i + 1} needs shorter writing: ${segment.tempo.toFixed(3)}x`);
      segment.spokenDuration = segment.sourceDuration / segment.tempo;
      process.stdout.write(`Deepgram segment ${i + 1}/${segments.length}: ${segment.sourceDuration.toFixed(2)}s, ${segment.tempo.toFixed(3)}x\n`);
    }
  } finally { credential = ''; }

  const filters = [];
  const inputs = [];
  const cues = [];
  let cue = 1;
  segments.forEach((segment, i) => {
    inputs.push('-i', segment.audio);
    filters.push(`[${i + 1}:a]aresample=48000,atempo=${segment.tempo.toFixed(6)},highpass=f=65,afade=t=in:st=0:d=0.02,afade=t=out:st=${Math.max(0, segment.spokenDuration - 0.04).toFixed(6)}:d=0.04,adelay=${Math.round(segment.start * 1000)}:all=1[a${i}]`);
    const sentences = segment.text.match(/[^.!?]+[.!?]+/g).map(s => s.trim());
    const total = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0);
    let cursor = segment.start;
    for (const sentence of sentences) {
      const end = cursor + segment.spokenDuration * sentence.split(/\s+/).length / total;
      cues.push(`${cue++}\n${stamp(cursor)} --> ${stamp(end)}\n${wrap(sentence)}\n`);
      cursor = end;
    }
  });
  filters.push(`${segments.map((_, i) => `[a${i}]`).join('')}amix=inputs=${segments.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=7,apad=whole_dur=130,atrim=duration=130[audio]`);
  const captions = path.join(output, 'measureback-deepgram.srt');
  const movie = path.join(output, 'measureback-deepgram.mp4');
  assert.ok(!fs.existsSync(movie), 'Do not overwrite a previously rendered video');
  fs.writeFileSync(captions, cues.join('\n'));
  fs.writeFileSync(path.join(output, 'narration.md'), '# MeasureBack narration\n\nProvider: Deepgram Aura 2 Thalia.\n\n' + segments.map(s => `${stamp(s.start)}\n\n${s.text}`).join('\n\n') + '\n');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-i', prior.movie, ...inputs, '-i', captions,
    '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[audio]', '-map', `${segments.length + 1}:0`,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default',
    '-metadata', 'title=MeasureBack | Recipe clarification with CALL E',
    '-metadata', 'comment=Actual browser recording; authored conversation; Deepgram Aura 2 narration; no live interview claimed.',
    '-movflags', '+faststart', '-t', '130', movie]);
  const metadata = probe(movie);
  assert.equal(Number(metadata.format.duration), 130);
  assert.ok(metadata.streams.some(s => s.codec_type === 'video' && s.width === 1920 && s.height === 1080));
  assert.ok(metadata.streams.some(s => s.codec_type === 'audio'));
  run(ffmpeg, ['-v', 'error', '-i', movie, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', movie, '-t', '16', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', path.join(output, 'narration-preview.mp3')]);
  fs.writeFileSync(path.join(output, 'render-report.json'), JSON.stringify({provider: 'Deepgram', model, movie, captions, duration: 130, segments, metadata, decodedWithoutErrors: true, noLiveCookCall: true}, null, 2));
  process.stdout.write(`Verified Deepgram video: ${movie}\n`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
