// Run: npx tsx scripts/loud-club-test.ts
// Numbers are real minutes from the night of 21 Nov (C12, phone in a pocket): loud bass-heavy music was
// called "talking". (The movement label "walking" on the same minutes is no longer used by the recap.)
import { isLoudBassMusic, classifyAudio } from '../src/processing/AudioClassifier';

let failed = 0;
const expect = (name: string, ok: boolean) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };

// dB, sub-bass share
expect('107 dB with 93% bass is music', isLoudBassMusic(107, 0.93));
expect('102 dB with 67% bass is music', isLoudBassMusic(102, 0.67));
expect('98 dB shouting with 1% bass is not music', !isLoudBassMusic(98, 0.01));
expect('100 dB with 8% bass is not music (voices)', !isLoudBassMusic(101, 0.08));
expect('76 dB with 31% bass is left to the other rules', !isLoudBassMusic(76, 0.31));
expect('a loud bass minute is classed as loud music, not talking', classifyAudio(105, isLoudBassMusic(105, 0.8)) === 'loud_music');
expect('without the rule the same minute was "talking"', classifyAudio(105, false) === 'talking');

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nAll checks passed.');
