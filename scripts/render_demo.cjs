#!/usr/bin/env node
'use strict';

// Local-only post-production for the genuine browser recording. macOS say is
// the narrator; no network TTS, credentials, recreated UI or synthetic calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const output = path.resolve(process.argv[2] || 'output/demo/2026-09-12T08-04-31-794Z');
const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const ffprobe = '/opt/homebrew/bin/ffprobe';
const recording = JSON.parse(fs.readFileSync(path.join(output, 'recording.json'), 'utf8'));
const audioDir = path.join(output, 'narration');
fs.mkdirSync(audioDir, { recursive: true });

// Edited against the installed no-ai-slop skill and eval. Statements distinguish
// the authored transcript from verified code and unperformed live interviews.
const segments = [
  {
    start: 0.6, end: 20.2,
    text: "MeasureBack is a CALL E recipe interviewer for a consenting family member. It keeps each quantity tied to the cook's words. This authored example starts with two bowls of rice. Their capacity is unknown, so the app asks for a measure instead of guessing.",
  },
  {
    start: 20.9, end: 40.2,
    text: "The cook says the bowl holds two hundred and fifty millilitres. Two bowls make five hundred millilitres for four people. At six servings, the engine calculates seven hundred and fifty. That result comes from checked quantities and unit conversions, with the cook's quotation beside it.",
  },
  {
    start: 41.0, end: 60.5,
    text: "During the readback, the cook corrects the water from one thousand to nine hundred millilitres. For six servings, that becomes thirteen hundred and fifty. Clicking Water opens the correction and its transcript reference. The earlier amount remains in the evidence, so you can see what changed.",
  },
  {
    start: 61.5, end: 74.7,
    text: "Four servings restores the original rice and water amounts. Back at six, the cinnamon stick becomes one and a half pieces. That needs a person's decision. Salt stays to taste.",
  },
  {
    start: 75.3, end: 89.7,
    text: "The method keeps eighteen minutes as spoken. Scaling ingredients does not establish a new cooking time. Each step keeps its order and source. The full conversation remains available for review, including permission to capture and share the recipe.",
  },
  {
    start: 90.3, end: 102.7,
    text: "The local app prepares one interview with an authorized cook. These names and this phone number are fictional. Capture and sharing permission must be confirmed. A separate approval is required before a call.",
  },
  {
    start: 103.1, end: 109.4,
    text: "Choose a fixed language, or request adaptation when supported. Following the cook is best effort.",
  },
  {
    start: 109.9, end: 119.8,
    text: "The preview masks the destination. Live calling is disabled. API wiring and failure handling were tested, but no real person was called for this entry.",
  },
  {
    start: 120.4, end: 129.7,
    text: "You can inspect every supported measurement, preserve the cook's correction, and keep unknown quantities unresolved. The recipe stays private until you choose to share it.",
  },
];

function probe(file) {
  return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function wrap(text, width = 64) {
  const lines = [];
  for (const word of text.split(/\s+/)) {
    const i = lines.length - 1;
    if (i < 0 || lines[i].length + word.length + 1 > width) lines.push(word);
    else lines[i] += ` ${word}`;
  }
  return lines.join('\n');
}

let cueIndex = 1;
const cues = [];
const audioInputs = [];
const filters = [];
segments.forEach((segment, index) => {
  const filename = path.join(audioDir, `${String(index + 1).padStart(2, '0')}.aiff`);
  execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '168', '-o', filename, segment.text], { stdio: 'inherit' });
  const info = probe(filename);
  const duration = Number(info.format.duration);
  assert.ok(duration > 1, 'The local narrator must produce audible output');
  const available = segment.end - segment.start;
  const tempo = Math.max(1, duration / available);
  assert.ok(tempo <= 1.2, `Narration segment ${index + 1} needs editing, not excessive speed: ${tempo}`);
  segment.sourceDuration = duration;
  segment.tempo = tempo;
  segment.spokenDuration = duration / tempo;
  audioInputs.push('-i', filename);
  const n = index + 1;
  filters.push(`[${n}:a]aresample=48000,atempo=${tempo.toFixed(5)},highpass=f=70,afade=t=in:st=0:d=0.025,afade=t=out:st=${Math.max(0, segment.spokenDuration - 0.045).toFixed(5)}:d=0.04,adelay=${Math.round(segment.start * 1000)}:all=1[a${n}]`);
  const sentences = segment.text.match(/[^.!?]+[.!?]+/g).map(sentence => sentence.trim());
  const totalWords = sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0);
  let cursor = segment.start;
  for (const sentence of sentences) {
    const end = cursor + segment.spokenDuration * sentence.split(/\s+/).length / totalWords;
    cues.push(`${cueIndex++}\n${srtTime(cursor)} --> ${srtTime(end)}\n${wrap(sentence)}\n`);
    cursor = end;
  }
  process.stdout.write(`Narration ${index + 1}: ${duration.toFixed(2)}s at ${tempo.toFixed(3)}x\n`);
});

const subtitles = path.join(output, 'measureback-demo.srt');
fs.writeFileSync(subtitles, cues.join('\n'));
fs.writeFileSync(path.join(output, 'narration.md'), '# MeasureBack narration\n\n' + segments.map(segment => `${srtTime(segment.start).replace(',', '.')}\n\n${segment.text}`).join('\n\n') + '\n');
filters.push(`${segments.map((_, i) => `[a${i + 1}]`).join('')}amix=inputs=${segments.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=7,apad=whole_dur=130,atrim=duration=130[audio]`);
filters.push('[0:v]fps=30,format=yuv420p,fade=t=in:st=0:d=0.2,fade=t=out:st=129.5:d=0.5[video]');
const movie = path.join(output, 'measureback-demo.mp4');
const subtitleIndex = segments.length + 1;
execFileSync(ffmpeg, [
  '-y', '-hide_banner', '-loglevel', 'warning',
  '-ss', String(recording.loadLeadInSeconds), '-i', recording.videoPath,
  ...audioInputs, '-i', subtitles,
  '-filter_complex', filters.join(';'),
  '-map', '[video]', '-map', '[audio]', '-map', `${subtitleIndex}:0`,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default',
  '-metadata', 'title=MeasureBack | A recipe interview you can check',
  '-metadata', 'comment=Actual browser interactions; authored fictional transcript; local synthetic narration; no live interview claimed.',
  '-movflags', '+faststart', '-t', '130', movie,
], { stdio: 'inherit' });

const metadata = probe(movie);
const duration = Number(metadata.format.duration);
assert.ok(duration >= 129 && duration < 180);
assert.ok(metadata.streams.some(stream => stream.codec_type === 'video' && stream.width === 1920 && stream.height === 1080));
assert.ok(metadata.streams.some(stream => stream.codec_type === 'audio'));
assert.ok(metadata.streams.some(stream => stream.codec_type === 'subtitle'));
execFileSync(ffmpeg, ['-v', 'error', '-i', movie, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { stdio: 'inherit' });
for (const second of [2, 47, 78, 114, 125]) {
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', movie, '-frames:v', '1', '-update', '1', path.join(output, `spot-${second}s.png`)], { stdio: 'inherit' });
}
execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', movie, '-t', '8', '-vn', '-c:a', 'libmp3lame', '-b:a', '96k', path.join(output, 'audio-check.mp3')], { stdio: 'inherit' });
fs.writeFileSync(path.join(output, 'render-report.json'), JSON.stringify({
  movie, subtitles, narration: 'Local macOS Samantha at 168 words per minute',
  duration, segments, metadata, decodedWithoutErrors: true,
  captionTiming: 'Sentence timings proportional to the measured local narration segment; soft subtitle track and separate SRT.',
  editorialReview: 'Applied installed no-ai-slop SKILL.md and eval.md. Concrete claims retained; no live interview or prize claim.',
}, null, 2));
process.stdout.write(`Verified MP4: ${movie}\nDuration: ${duration}s\nNarration: ${path.join(output, 'narration.md')}\nCaptions: ${subtitles}\n`);
