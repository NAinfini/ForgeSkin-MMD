// A .dance playing on the open model, the way the game plays it: the 50 canonical joints from the file, then the extra
// bones it names (twist bones, skirt bones, D chains), copied onto the model by the same PoseCopy port the game uses.
import { Object3D, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createSkinPose } from '../../../../../Web/src/shared/render/imported-skin-pose';
import { friendly } from '../errors';
import { call } from '../protocol';
import { useStore } from '../store';
import { boneOf, modelScene, restPose } from '../character/model';
import { matchOf, useCharacter } from '../character/state';
import { danceSeconds, type DanceFile } from './danceFile';


/** Game rotations and points in this editor's glTF space: X is mirrored between the two. */
const flipTurn = (q: Quaternion) => new Quaternion(q.x, -q.y, -q.z, q.w);
const flipPoint = (v: Vector3) => new Vector3(-v.x, v.y, v.z);

/**
 * Rest height of センター in the MMD models these dances are baked from (metres, 0.08 VMD scale).
 * A `.dance` stores its hip travel in that same space, so a model built like the source moves exactly as authored —
 * which is what Blender shows and what the camera keys were framed against.
 */
const SOURCE_HIP = 0.682;

export interface DancePlayer {
  dance: DanceFile;
  /** Second count, as the plugin counts it. */
  duration: number;
  /** Poses the model at `seconds` into the dance. */
  sample(seconds: number): void;
  dispose(): void;
}

const BUNDLED = import.meta.glob<string>('../motions/*.glb', { eager: true, query: '?url', import: 'default' });

/** The canonical player body the site ships (its joints are the names `character.links` speaks). */
let bodyOnce: Promise<Object3D> | null = null;
function canonicalBody(): Promise<Object3D> {
  bodyOnce ??= fetch(BUNDLED['../motions/idle.glb']!)
    .then((r) => r.arrayBuffer())
    .then((b) => new GLTFLoader().parseAsync(b, ''))
    .then((file) => file.scene)
    .catch((e: unknown) => {
      bodyOnce = null;
      throw e;
    });
  return bodyOnce.then((scene) => scene.clone(true));
}

export async function dancePlayer(dance: DanceFile): Promise<DancePlayer | null> {
  const model = modelScene();
  const state = useCharacter.getState();
  if (!model || !state.files) return null;
  try {
    const body = await canonicalBody();
    const match = matchOf(state);
    const fingers = !!body.getObjectByName('leftThumb1');
    const { links, reach } = await call('character.links', { descriptor: state.files.descriptor, bones: match, fingers });
    const kept = links.flatMap((l, j) => (l.skip ? [] : [j]));
    const index = new Map(kept.map((j, k) => [j, k]));
    const modelBones: Object3D[] = [];
    const hostBones: Object3D[] = [];
    for (const j of kept) {
      const bone = boneOf(match[links[j]!.joint]);
      const host = body.getObjectByName(links[j]!.joint);
      if (!bone || !host) throw new Error(`no bone for ${links[j]!.joint}`);
      modelBones.push(bone);
      hostBones.push(host);
    }
    restPose();
    body.updateMatrixWorld(true);
    model.updateMatrixWorld(true);
    // Extra bones are turned in the model's own space, whatever turn the stage gave the model root.
    const rootWorld = model.getWorldQuaternion(new Quaternion());
    const rootInverse = rootWorld.clone().invert();
    const hostRest = hostBones.map((b) => b.getWorldQuaternion(new Quaternion()));
    const hostParent = hostBones.map((b) => b.parent as Object3D | null);
    const hostRestPos = hostBones.map((b) => b.getWorldPosition(new Vector3()));
    const pose = createSkinPose({
      links: kept.map((j) => ({
        toward: links[j]!.toward >= 0 ? index.get(links[j]!.toward)! : -1,
        from: links[j]!.from >= 0 ? index.get(links[j]!.from)! : -1,
        offset: [0, 0, 0] as const,
      })),
      modelBones,
      modelRoot: model,
      hostBones,
      hostRoot: body,
      reach: reach.filter((r) => r.every((j) => index.has(j))).map((r) => r.map((j) => index.get(j)!) as [number, number, number]),
    });
    if (!pose) throw new Error('the hips stand too low');

    // The file's extra bones name bones of the model itself (twist bones, the D chains, skirts): the game turns each of
    // them by the track's world delta from its rest, so the model's rest orientation is all that is needed.
    const restQuat = new Map<string, Quaternion>();
    const depth = new Map<string, number>();
    for (const track of dance.rotTracks) {
      if (restQuat.has(track.name)) continue;
      const bone = boneOf(track.name);
      if (!bone) continue;
      restQuat.set(track.name, rootInverse.clone().multiply(bone.getWorldQuaternion(new Quaternion())));
      let d = 0;
      for (let p = bone.parent; p; p = p.parent) d++;
      depth.set(track.name, d);
    }
    const extra = dance.rotTracks
      .filter((t) => restQuat.has(t.name))
      .map((t) => ({ track: t, bone: boneOf(t.name)!, depth: depth.get(t.name)!, rest: restQuat.get(t.name)! }))
      .sort((a, b) => a.depth - b.depth);

    const joints = Math.min(dance.joints, links.length);
    const hipJoint = kept.indexOf(0) >= 0 ? kept.indexOf(0) : -1;
    const hipHeight = hostRestPos[0]?.y ?? SOURCE_HIP;
    const hipRestLocal = hipJoint >= 0 ? hostBones[hipJoint]!.position.clone() : null;
    // The file's travel is in the source model's own metres, measured from a hip at `SOURCE_HIP` — not from the game's
    // canonical 1.04 body. Scaling it by the game's 1.04 made every crouch two thirds as deep as the dance wrote it: at
    // the end of a kneeling move the figure sat 24 cm too high, which pushed it up out of the camera's frame.
    const hipScale = hipHeight > 0.1 ? hipHeight / SOURCE_HIP : 1;
    const turn = new Quaternion();
    const other = new Quaternion();
    const frameOf = (seconds: number) => Math.min(Math.max(seconds * dance.rate, 0), Math.max(0, dance.frames - 1));

    const frameTurn = (joint: number, frame: number, out: Quaternion): Quaternion => {
      const f0 = Math.floor(frame);
      const f1 = Math.min(f0 + 1, Math.max(0, dance.frames - 1));
      const a = (f0 * dance.joints + joint) * 4;
      const b = (f1 * dance.joints + joint) * 4;
      const u = frame - f0;
      out.set(dance.turns[a]!, dance.turns[a + 1]!, dance.turns[a + 2]!, dance.turns[a + 3]!);
      if (u > 1e-4 && f1 !== f0) {
        other.set(dance.turns[b]!, dance.turns[b + 1]!, dance.turns[b + 2]!, dance.turns[b + 3]!);
        out.slerp(other, u);
      }
      return out.normalize();
    };

    return {
      dance,
      duration: danceSeconds(dance),
      sample(seconds: number) {
        const frame = frameOf(seconds);
        // Canonical joints: the file's turn about the joint's rest, parent first so each local turn is its own.
        for (let k = 0; k < kept.length; k++) {
          const joint = kept[k]!;
          if (joint >= joints) continue;
          const host = hostBones[k]!;
          const parent = hostParent[k];
          const world = flipTurn(frameTurn(joint, frame, turn)).multiply(hostRest[k]!);
          const parentWorld = parent ? parent.getWorldQuaternion(other) : new Quaternion();
          host.quaternion.copy(parentWorld.invert().multiply(world));
          host.updateMatrixWorld(true);
        }
        // The hip's travel: the file holds it in the source model's metres, measured from a hip at `SOURCE_HIP`.
        if (hipJoint >= 0) {
          const h0 = Math.floor(frame);
          const h1 = Math.min(h0 + 1, Math.max(0, dance.frames - 1));
          const u = frame - h0;
          const hips = new Vector3();
          for (let axis = 0; axis < 3; axis++) {
            const a = dance.hips[h0 * 3 + axis] ?? 0;
            const b = dance.hips[h1 * 3 + axis] ?? a;
            hips.setComponent(axis, a + (b - a) * u);
          }
          const hip = hostBones[hipJoint]!;
          hip.position.copy(hipRestLocal!).add(flipPoint(hips).multiplyScalar(hipScale));
          hip.updateMatrixWorld(true);
        }
        body.updateMatrixWorld(true);
        pose.apply();
        // Extra bones last, as the game applies them, parent before child.
        for (const { track, bone, rest } of extra) {
          const f0 = Math.floor(frame);
          const f1 = Math.min(f0 + 1, Math.max(0, dance.frames - 1));
          const u = frame - f0;
          const a = f0 * 4;
          const b = f1 * 4;
          turn.set(track.data[a]!, track.data[a + 1]!, track.data[a + 2]!, track.data[a + 3]!);
          if (u > 1e-4 && f1 !== f0) {
            other.set(track.data[b]!, track.data[b + 1]!, track.data[b + 2]!, track.data[b + 3]!);
            turn.slerp(other, u);
          }
          const world = rootWorld.clone().multiply(flipTurn(turn.normalize())).multiply(rest);
          const parentWorld = bone.parent ? bone.parent.getWorldQuaternion(other) : new Quaternion();
          bone.quaternion.copy(parentWorld.invert().multiply(world));
          bone.updateMatrixWorld(true);
        }
      },
      dispose() {
        body.removeFromParent();
      },
    };
  } catch (e) {
    useStore.getState().toast('error', friendly(e));
    return null;
  }
}