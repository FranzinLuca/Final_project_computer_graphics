/**
 * tweens.js — one shared tween.js Group for the whole project.
 *
 * Every tween in the project is added here, and main.js calls
 * `tweens.update(timeMs)` exactly once per frame. Owning the group
 * explicitly (rather than relying on tween.js's implicit global group) means
 * animations can be paused, cleared or stepped as a unit later on.
 *
 * Usage:
 *   import { Tween, Easing } from '@tweenjs/tween.js';
 *   import { tweens } from './tweens.js';
 *
 *   const t = new Tween(lid.rotation)
 *     .to({ x: -Math.PI * 110 / 180 }, 900)
 *     .easing(Easing.Cubic.Out);
 *   tweens.add(t);
 *   t.start();
 */

import { Group } from '@tweenjs/tween.js';

export const tweens = new Group();