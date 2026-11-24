# Blender headless: bake an MMD motion VMD into the plugin's .dance v5 file.
#
#   blender -b --python blender_bake_vmd.py -- <pmx> <vmd> <model.json> <manifest.json> <canonical.json> <out.dance> [name]
#
# What goes into the file:
#   * the 50 canonical joints as `turn` quaternions (same convention as ForgeCore ClipRig/ExportDance),
#     computed from the model's rest (positions + hand rest orientation) and the PMX pose,
#   * the hips' world offset,
#   * per-model-bone world rotation deltas vs rest (v5 "full pose" tracks), named as in the game model,
#     so the plugin can drive the imported model exactly like MMD (twist bones, toes, grants included),
#   * v6: per-model-bone world POSITION deltas vs rest for every bone that translates on its own
#     (腰/センター/全ての親/目...). The MMD hip drop/sway lives on 腰's position channel, not センター's;
#     without it the model keeps the rest hip height while the IK-solved legs crouch -> feet float
#     by exactly the crouch depth ("the deeper the crouch, the higher the float").
import bpy, sys, os, json, math, time, struct
from mathutils import Matrix, Vector, Quaternion

argv = sys.argv[sys.argv.index("--") + 1:]
PMX, VMD, MODEL_JSON, MANIFEST_JSON, CANON_JSON, OUT = argv[:6]
NAME = argv[6] if len(argv) > 6 else os.path.splitext(os.path.basename(VMD))[0]
LOG = open(OUT + ".log", "w", encoding="utf-8")


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    LOG.write(s + "\n")
    LOG.flush()


# ---------------------------------------------------------------- canonical rig
CAN = json.load(open(CANON_JSON, encoding="utf-8"))
CNAMES, CPARENT, CPOSE, COFF, CTOW = CAN["names"], CAN["parent"], CAN["pose"], CAN["offset"], CAN["toward"]
assert len(CNAMES) == 50

C_RESTW = []
for j in range(50):
    q = Quaternion((CPOSE[j][3], CPOSE[j][0], CPOSE[j][1], CPOSE[j][2]))
    C_RESTW.append(q if CPARENT[j] < 0 else (C_RESTW[CPARENT[j]] @ q).normalized())
C_POS = []
for j in range(50):
    off = Vector(COFF[j])
    C_POS.append(off if CPARENT[j] < 0 else C_POS[CPARENT[j]] + (C_RESTW[CPARENT[j]] @ off))


def rest_point(j):
    p = C_POS[j]
    return Vector((-p.x, p.y, p.z))


def rest_direction(a, b):
    d = C_POS[b] - C_POS[a]
    v = Vector((-d.x, d.y, d.z))
    return v.normalized() if v.length > 1e-9 else Vector((0, 1, 0))


# ---------------------------------------------------------------- game model rest
MODEL = json.load(open(MODEL_JSON, encoding="utf-8"))
MBONES = MODEL["skin"]["bones"]
MIDX = {b["name"]: i for i, b in enumerate(MBONES)}


def model_rest_pos(name):
    r = MBONES[MIDX[name]]["rest"]
    return Vector((r[12], r[13], r[14]))


def model_rest_rot(name):
    r = MBONES[MIDX[name]]["rest"]
    m = Matrix((tuple(r[0:3]), tuple(r[4:7]), tuple(r[8:11]))).transposed()
    return m.to_quaternion().normalized()


SKIN = json.load(open(MANIFEST_JSON, encoding="utf-8"))["character"]
JOINT_BONE = SKIN["bones"]          # canonical joint -> model bone
assert all(j in JOINT_BONE for j in CNAMES), "manifest misses joints"

# canonical joint -> Blender/PMX bone (mmd_tools renames 左X to X.L)
FING = ["親指", "人指", "中指", "薬指", "小指"]
FING_JOINT = ["Thumb", "Index", "Middle", "Ring", "Pinky"]
BODY_MAP = {
    "hip": "腰",
    "leftUpperLeg": "足.L", "leftLowerLeg": "ひざ.L", "leftFoot": "足首.L",
    "rightUpperLeg": "足.R", "rightLowerLeg": "ひざ.R", "rightFoot": "足首.R",
    "spine0": "上半身", "spine1": "上半身2", "spine2": "上半身1",
    "leftShoulder": "肩.L", "leftUpperArm": "腕.L", "leftLowerArm": "ひじ.L", "leftHand": "手首.L",
    "rightShoulder": "肩.R", "rightUpperArm": "腕.R", "rightLowerArm": "ひじ.R", "rightHand": "手首.R",
    "neck": "首", "head": "頭",
}
for side, s in (("left", "L"), ("right", "R")):
    for fi, f in enumerate(FING):
        jn = FING_JOINT[fi]
        # 親指０/１/２ (thumb base + two joints), 人指１..３ etc.
        digits = ("０", "１", "２") if fi == 0 else ("１", "２", "３")
        for d in range(3):
            BODY_MAP["%s%s%d" % (side, jn, d + 1)] = "%s%s.%s" % (f, digits[d], s)

# model name for each canonical joint (the model's own bone is what both ForgeSkin and this bake use)
JOINT_MODEL = [JOINT_BONE[n] for n in CNAMES]
JOINT_BLENDER = []   # resolved after the armature is imported: model bone name, else the legacy PMX name

# ---------------------------------------------------------------- P: blender -> game axes
# game = (-bx, bz, -by), the same mapping the camera bake used and the model descriptor matches.
P = Matrix(((-1.0, 0.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0), (0.0, -1.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0)))
P_INV = P.inverted()


def q_game(q):
    return (P @ q.to_matrix().to_4x4() @ P_INV).to_quaternion().normalized()


def v_game(v):
    return Vector((-v[0], v[2], -v[1]))


def palm_frame(aim, knuckles):
    y = aim.normalized()
    x = (knuckles - y * knuckles.dot(y)).normalized()
    z = x.cross(y)
    return Matrix((x, y, z)).transposed().to_quaternion().normalized()


# ---------------------------------------------------------------- aligned (JointRetarget port)
SRC_REST_POS = [model_rest_pos(JOINT_MODEL[j]) for j in range(50)]
SRC_REST_ROT = [model_rest_rot(JOINT_MODEL[j]) for j in range(50)]
PRESENT = [True] * 50

SWING = [Quaternion((1, 0, 0, 0)) for _ in range(50)]
for j in range(50):
    if j in (13, 17):
        first = 20 if j == 13 else 35
        idx, mid, pink = first + 3, first + 6, first + 12
        if PRESENT[idx] and PRESENT[mid] and PRESENT[pink]:
            SWING[j] = (palm_frame(rest_point(mid) - rest_point(j), rest_point(idx) - rest_point(pink))
                        @ palm_frame(SRC_REST_POS[mid] - SRC_REST_POS[j], SRC_REST_POS[idx] - SRC_REST_POS[pink]).inverted()).normalized()
        continue
    if len(CTOW[j]) == 0:
        if CPARENT[j] >= 0:
            SWING[j] = SWING[CPARENT[j]]
        continue
    for to in CTOW[j]:
        if not PRESENT[to]:
            continue
        a = SRC_REST_POS[to] - SRC_REST_POS[j]
        b = rest_direction(j, to)
        SWING[j] = a.rotation_difference(b).normalized() if a.length > 1e-9 else Quaternion((1, 0, 0, 0))
        break

ALIGNED = []
for j in range(50):
    # ForgeCore 的 JointRetarget：aligned = swing * restRotation，**每一根关节都乘 restRotation**（包括手 13/17）。
    # 手 13/17 的 swing 已经是掌面（palm frame）对齐量，但依然要再乘模型手的静置旋转；
    # 少了它，clip 里手关节的 turn 就错一个旋转，游戏自带模型（原皮）的手会被拧到错误方向。
    ALIGNED.append((SWING[j] @ SRC_REST_ROT[j]).normalized())


# ---------------------------------------------------------------- import PMX + VMD
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.preferences.addon_enable(module="bl_ext.blender_org.mmd_tools")
bpy.ops.mmd_tools.import_model(filepath=PMX, scale=0.08, types={'MESH', 'ARMATURE'})
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
log("armature", arm.name, "bones", len(arm.data.bones), "in", round(time.time() - t0, 1), "s")

BONE = {b.name: b for b in arm.data.bones}
REST_Q = {}
REST_HEAD = {}
for b in arm.data.bones:
    REST_Q[b.name] = b.matrix_local.to_quaternion().normalized()
    REST_HEAD[b.name] = b.head_local.copy()

# pick, for every canonical joint, the Blender bone that carries the model's bone of that joint
JOINT_BLENDER = []
for j in range(50):
    m = JOINT_MODEL[j]
    legacy = BODY_MAP[CNAMES[j]]
    JOINT_BLENDER.append(m if m in REST_Q else legacy)
BL_TO_MODEL = {JOINT_BLENDER[j]: JOINT_MODEL[j] for j in range(50)}
log("canonical joints mapped:", ", ".join("%s=%s(%s)" % (CNAMES[j], JOINT_BLENDER[j], JOINT_MODEL[j]) for j in range(20)))

missing = [n for n in JOINT_BLENDER if n not in arm.pose.bones]
if missing:
    log("WARNING missing blender bones:", missing)

bpy.ops.object.select_all(action='DESELECT')
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
t0 = time.time()
bpy.ops.mmd_tools.import_vmd(filepath=VMD, scale=0.08, bone_mapper='PMX', update_scene_settings=True)
log("vmd imported in", round(time.time() - t0, 1), "s; frames", bpy.context.scene.frame_start, "-", bpy.context.scene.frame_end)

fs, fe = int(bpy.context.scene.frame_start), int(bpy.context.scene.frame_end)
N = fe - fs + 1
FPS = 30.0

# bones to sample: canonical ones + every bone that is keyed or constraint-driven (parents of keyed ones need no track:
# a static bone keeps its rest local rotation, which the plugin leaves alone).
cand = set(JOINT_BLENDER)
act = arm.animation_data.action if arm.animation_data else None
if act:
    import re
    for fc in act.fcurves:
        m = re.search(r'pose\.bones\["([^"]+)"\]', fc.data_path)
        if m:
            cand.add(m.group(1))
for pb in arm.pose.bones:
    if len(pb.constraints):
        cand.add(pb.name)
cand = sorted(n for n in cand if n in REST_Q)  # sorted so the same dance always bakes to the same bytes
log("candidate bones", len(cand))

# ---------------------------------------------------------------- sample
D = {n: [] for n in cand}
prev_q = {}
turns = []
hips = []
last_log = time.time()
# v6 位移：每帧记录每根候选骨的世界位置（紧凑 float 数组），同时判断"骨头自己有没有局部位移"。
# 判定：本骨世界位置 − (父骨当前平移 + 父骨当前旋转 @ 静置偏移)。父级旋转/IK 造成的位移会被
# 这一项减掉，只有真正在自己位置轨道上动过的骨头（センター/腰/全ての親/目…）才会留下偏差。
from array import array
WT = {n: array('f') for n in cand}
own_move = {n: False for n in cand}
for f in range(fs, fe + 1):
    bpy.context.scene.frame_set(f)
    bpy.context.view_layer.update()
    for n in cand:
        pb = arm.pose.bones[n]
        qp = pb.matrix.to_quaternion().normalized()
        q0 = prev_q.get(n)
        wt = pb.matrix.translation
        WT[n].extend((wt.x, wt.y, wt.z))
        par = pb.parent
        if par is None:
            dev = wt.length
        else:
            # 期望位置 = 父骨当前姿态矩阵 × 静置相对矩阵（完整 4x4：MMD 骨骼静置矩阵常带镜像/缩放，
            # 用四元数近似会把 232 根骨全误判成"有位移"，也会漏掉真的位移）。
            pred = (par.matrix @ par.bone.matrix_local.inverted() @ pb.bone.matrix_local).translation
            dev = (wt - pred).length
        if not own_move[n] and dev > 0.0015:
            own_move[n] = True
        if q0 is not None and abs(q0.dot(qp)) > 1.0 - 1e-9:
            D[n].append(D[n][-1])
            continue
        prev_q[n] = qp
        D[n].append((q_game(qp) @ q_game(REST_Q[n]).inverted()).normalized())
    turn_f = []
    for j in range(50):
        dn = D[JOINT_BLENDER[j]][-1]
        w = (dn @ SRC_REST_ROT[j]).normalized()
        turn_f.append((w @ ALIGNED[j].inverted()).normalized())
    turns.append(turn_f)
    hb = arm.pose.bones.get(JOINT_BLENDER[0])
    if hb is not None:
        hips.append(v_game(hb.matrix.translation - REST_HEAD[JOINT_BLENDER[0]]))
    else:
        hips.append(Vector((0, 0, 0)))
    if time.time() - last_log > 10:
        last_log = time.time()
        log("  sampled", f - fs + 1, "/", N)

log("sampled", N, "frames")

# ---------------------------------------------------------------- pick full-pose tracks
# model bone name -> per-frame D
rename = {
    "腕捩.L": "arm twist.L", "腕捩.R": "arm twist.R",
    "手捩.L": "hand twist.L", "手捩.R": "hand twist.R",
    "肩P.L": "shoulder parent helper.L", "肩P.R": "shoulder parent helper.R",
    "肩C.L": "shoulder cancel helper.L", "肩C.R": "shoulder cancel helper.R",
    # PMX 的 腰 就是模型里的 hips 骨（センター/グルーブ/グルーブ2 之下的那根）。
    # 以前没有这条映射：腰 的轨道被丢进 unmapped，而 ALIAS 又把 センター 的旋转冒充成 "hips"。
    "腰": "hips",
}
# model bone names that are already driven through the canonical 50
canonical_model = set(JOINT_MODEL)

tracks = {}   # model bone name -> frames of D
unmapped = []
for n in cand:
    if n in BL_TO_MODEL:
        tracks[BL_TO_MODEL[n]] = D[n]
        continue
    mname = n if n in MIDX else rename.get(n)
    if mname is None or mname not in MIDX:
        unmapped.append(n)
        continue
    if mname in canonical_model:
        continue
    arr = D[n]
    moved = False
    for q in arr:
        if abs(q.w) < 1.0 - 1e-7:
            moved = True
            break
    if moved:
        tracks[mname] = arr
# aliases for a second naming of the same skeleton (the English-renamed skin has the same bones under other names)
# 注意 hips：模型的 hips 骨是 PMX 的 腰（上条 rename），旋转轨道由 腰 直接给出，不能再拿 センター 冒充。
ALIAS = {"spine": "上半身", "spine1": "上半身2", "chest": "上半身1", "neck": "首", "head": "頭"}
FULL = "０１２３４５６７８９"
for s in ("L", "R"):
    ALIAS["thigh." + s] = "足." + s
    ALIAS["shin." + s] = "ひざ." + s
    ALIAS["foot." + s] = "足首." + s
    ALIAS["shoulder." + s] = "肩." + s
    ALIAS["upper_arm." + s] = "腕." + s
    ALIAS["forearm." + s] = "ひじ." + s
    ALIAS["hand." + s] = "手首." + s
    ALIAS["thumb.1." + s] = "親指０." + s
    ALIAS["thumb.2." + s] = "親指１." + s
    ALIAS["thumb.3." + s] = "親指２." + s
    for eng, jp in (("index", "人指"), ("middle", "中指"), ("ring", "薬指"), ("pinky", "小指")):
        for d in (1, 2, 3):
            ALIAS["%s.%d.%s" % (eng, d, s)] = "%s%s.%s" % (jp, FULL[d], s)
    ALIAS["arm twist." + s] = "腕捩." + s
    ALIAS["hand twist." + s] = "手捩." + s
    ALIAS["shoulder cancel helper." + s] = "肩C." + s
    ALIAS["shoulder parent helper." + s] = "肩P." + s

added = 0
for old, src in ALIAS.items():
    if old not in tracks and src in tracks:
        tracks[old] = tracks[src]
        added += 1
log("tracks", len(tracks), "(aliases +%d)" % added, "unmapped bones", len(unmapped), ("(" + ", ".join(unmapped[:8]) + "...)") if len(unmapped) > 8 else "")

# ---------------------------------------------------------------- v6 position tracks
# 自己带位移的骨头（センター/腰/全ての親/目…）→ 每帧世界位置增量（游戏坐标轴，相对 Blender 静置位置）。
# 插件的公式：骨骼世界位置 = mesh.localToWorldMatrix × (静置位置 + 增量)，和旋转轨道同样按绝对数据摆。
postracks = {}
pos_unmapped = []
for n in cand:
    if not own_move[n]:
        continue
    if n in BL_TO_MODEL:
        mname = BL_TO_MODEL[n]
    else:
        mname = n if n in MIDX else rename.get(n)
    if mname is None or mname not in MIDX:
        pos_unmapped.append(n)
        continue
    if mname in postracks:
        continue
    w = WT[n]
    r = v_game(REST_HEAD[n])
    arr = []
    for i in range(0, len(w), 3):
        arr.append(Vector((-w[i], w[i + 2], -w[i + 1])) - r)
    postracks[mname] = arr
log("position tracks", len(postracks), ":", ", ".join("%s(max %.3f)" % (k, max(vv.length for vv in v)) for k, v in postracks.items()))
if pos_unmapped:
    log("position tracks unmapped:", ", ".join(pos_unmapped[:12]))

# ---------------------------------------------------------------- write .dance v5
def qarr(q):
    return (q.x, q.y, q.z, q.w)


def cont(arr):
    out = []
    prev = None
    for q in arr:
        if prev is not None and (prev.x * q.x + prev.y * q.y + prev.z * q.z + prev.w * q.w) < 0:
            q = Quaternion((-q.w, -q.x, -q.y, -q.z))
        out.append(q)
        prev = q
    return out


for k in list(tracks.keys()):
    tracks[k] = cont(tracks[k])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "wb") as fh:
    def wstr(s):
        b = s.encode("utf-8")
        n = len(b)
        out = bytearray()
        while True:
            byte = n & 0x7F
            n >>= 7
            if n:
                out.append(byte | 0x80)
            else:
                out.append(byte)
                break
        out += b
        fh.write(out)

    fh.write(b"DNCE")
    fh.write(struct.pack("<i", 6))
    fh.write(struct.pack("<i", N))
    fh.write(struct.pack("<i", 50))
    fh.write(struct.pack("<f", FPS))
    wstr(NAME)
    wstr(JOINT_MODEL[0])  # v5: the model bone the full pose is anchored at
    hp = v_game(REST_HEAD[JOINT_BLENDER[0]])  # v5: hip rest in VMD/PMX space (camera track zero point)
    fh.write(struct.pack("<3f", hp.x, hp.y, hp.z))
    for i in range(N):
        for q in turns[i]:
            fh.write(struct.pack("<4f", q.x, q.y, q.z, q.w))
        h = hips[i]
        fh.write(struct.pack("<3f", h.x, h.y, h.z))
    fh.write(struct.pack("<i", len(tracks)))
    for mname, arr in tracks.items():
        wstr(mname)
        for q in arr:
            fh.write(struct.pack("<4f", q.x, q.y, q.z, q.w))
    # v6: 位移轨道
    fh.write(struct.pack("<i", len(postracks)))
    for mname, arr in postracks.items():
        wstr(mname)
        for d in arr:
            fh.write(struct.pack("<3f", d.x, d.y, d.z))

log("wrote", OUT, os.path.getsize(OUT), "bytes;", N, "frames;", len(tracks), "rotation tracks;", len(postracks), "position tracks")
log("track names:", ", ".join(sorted(tracks.keys())))
LOG.close()