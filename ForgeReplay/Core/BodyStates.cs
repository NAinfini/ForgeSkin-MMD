using System.Collections.Generic;

namespace ForgeReplay;

/// <summary>The states of the game's third-person player body controller (PlayerBaseRigController) the recorder and the tools name, and the table that
/// turns what the recorder's own player does into the states another machine's copy of that body plays: the local player's body is not read
/// (<c>PlayerRecorder</c>), so its PlayerAnimLayer events are made from here. A state number is Unity's <c>Animator.StringToHash</c> of the state's
/// name (CRC-32 of its UTF-8 bytes; a Core test checks every row). Rows under <see cref="Seen"/> were read from remote players' bodies
/// (replay/animator-states.log of 11-09 and 11-10, 12561 state lines) and every one of them was found by name in the controller asset; rows under
/// <see cref="NotSeen"/> are names in the controller asset that no logged body played. What each layer weighs was never logged: the weights the
/// local table gives are unverified.</summary>
internal static class BodyStates
{
    /// <summary>The body controller's layers (<c>PlayerAgent.ANIM_LAYER_*</c>); <see cref="Recorded"/> are the ones a recording holds.</summary>
    internal const int FullBody = 1, AimOffset = 4, UpperBody = 5, Additive = 6, LeftHand = 7, RightHand = 8, Layers = 9;

    /// <summary>A layer's weight is recorded in tenths.</summary>
    internal const int FullWeight = 10;

    /// <summary>The layers a recording holds: the third-person ones (2 and 3 pose the first-person arms).</summary>
    internal static readonly int[] Recorded = { FullBody, AimOffset, UpperBody, Additive, LeftHand, RightHand };

    /// <summary>The key of a PlayerAnimLayer state: one per player and layer.</summary>
    internal static ulong Key(int slot, int layer) => (ulong)(slot * 16 + layer);

    /// <summary>How long the local player's table holds a state before the layer goes back to rest, in milliseconds: the medians of how long remote
    /// bodies stayed in them in the same log (read ten times a second). The game build exposes no transition time, so a cross-fade is given <see cref="FadeMs"/>.</summary>
    internal const int FadeMs = 100, DeadMs = 2500, ReviveMs = 2300, EquipGunMs = 950, EquipMeleeMs = 720, ThrowMs = 520, SwingMs = 650, ReleaseMs = 600, ShoveMs = 600, RecoilMs = 320;

    /// <summary>How long an interact's state lasts (<see cref="InteractState"/>): a low pick-up 1.2 s, the other pick-ups 0.75 s, pointing 1.65 s; giving and
    /// taking a pack were held as long as the pack was in use, and placing a mine was not seen: both get 1.5 s, unverified.</summary>
    internal static int InteractMs(int type) => type switch { 1 => 1200, 2 or 3 => 750, 4 => 1650, _ => 1500 };

    internal static int Dead => Of("Dead");
    internal static int DeadIdle => Of("Dead_idle");
    internal static int Revive => Of("Revive");
    /// <summary>The upper-body layer's default state: where it rests, weightless, while a gun is held.</summary>
    internal static int UpperRest => Of("Spear_Idle");
    internal static int Empty => Of("empty");
    internal static int Recoil => Of("Rifle_Recoil");

    private static readonly (int Hash, string Name)[] Seen =
    {
        (-1822188247, "AmmoPack_idle"), (-920457963, "ClimbLadder"), (-1503198266, "ClimbLadderEnterBottom"), (-789000283, "ClimbLadderExitBottom"),
        (-352530914, "ClimbLadderExitTop"), (-1674048173, "ConsumablePack_Give"), (803981446, "ConsumablePack_Take"), (1035492301, "Consumable_Throw"),
        (1115759447, "Consumable_Throw_Charge"), (993993995, "Consumable_Throw_Charge_Idle"), (1293411866, "Dead"), (83611764, "Dead_idle"), (1901610868, "DefaultGrip"),
        (483441810, "Default_Movement"), (-1013317996, "DefoggerBig"), (-654811613, "Delivery_Bio_Tracker_1"), (700449694, "Delivery_Mine_Deployer_Direct_1"),
        (1594429564, "DisinfectionPack_idle"), (1032512850, "ElevatorHangIdle"), (1691821118, "EquipGeneric"), (819898422, "EquipKnife"), (-438472853, "EquipPrimary"),
        (1834056835, "EquipSecondary"), (-145735571, "EquipSledgehammer"), (352370365, "EquipSpear"), (-620049206, "EquipTool"), (1330988760, "FogRepeller"),
        (1741028529, "Fogrepeller_Throw"), (-928877594, "Fogrepeller_Throw_Charge"), (653427573, "Fogrepeller_Throw_Charge_Idle"), (-218021073, "Front_AutoShotgun_3_idle"),
        (-741382112, "Front_AutoShotgun_3_reload"), (1848035194, "Front_Machinegun_2_Animation_idle"), (-19522769, "Front_Machinegun_2_Animation_reload"),
        (534356912, "Front_Precision_2"), (1760124887, "Front_Precision_2_reload"), (397869626, "Front_Precision_3_Player_Idle"),
        (-442426492, "Front_Precision_3_Player_Reload"), (-1916873227, "Front_Revolver_2_Idle"), (-1317794437, "Front_Revolver_2_Reload"), (703862305, "Front_Rifle_1"),
        (-1325578341, "Front_Rifle_2"), (164621234, "Front_Rifle_2_reload"), (-1282331115, "Front_Rifle_3_idle"), (736282458, "Front_Rifle_3_reload_animation"),
        (-939384965, "Front_Shotgun_3"), (-1906472768, "Front_Shotgun_3_reload"), (1558948067, "Generator_Cell"), (1159820392, "GlueGrenade"),
        (-1213043458, "Knife_Charge_Left_Idle"), (1919317008, "Knife_Charge_Left_Release"), (-1463093082, "Knife_Charge_Left_Start"),
        (-2010534627, "Knife_Charge_Left_Start_Crouch"), (-1986326628, "Knife_Idle"), (-1761847882, "Knife_Idle_crouch"), (-564965284, "Knife_JumpLand"),
        (-1667255307, "Knife_JumpMidAir"), (1977237811, "Knife_JumpStart"), (-736558964, "Knife_Movement"), (-1322186900, "Knife_Stand_Shove"),
        (-1298775011, "Knife_SwingLeft"), (1436456992, "LockMelter"), (2038832366, "MediPack_idle"), (-1072057000, "Melee_JumpLand"), (680754764, "Melee_JumpMidAir"),
        (1923731407, "Melee_JumpStart"), (-900471416, "Melee_Movement"), (-1444512546, "Pickup_High"), (425517724, "Pickup_Low"), (-897945869, "Pickup_Mid"),
        (1342985417, "PistolAimOffset"), (-1670623806, "Pistol_JumpLand"), (1647296621, "Pistol_JumpStart"), (-1775887086, "Pistol_Movement"), (638613553, "Pistol_TurnL"),
        (-601930414, "Pistol_TurnR"), (726268102, "Player_Reviving_End_Crouch_A"), (1252081396, "Player_Reviving_Loop_Crouch_A"),
        (1717050679, "Player_Reviving_Start_Crouch_A"), (747021347, "Point_Forward"), (-323374038, "Revive"), (1044074034, "Rifle1_Reload"), (933186518, "RifleAimOffset"),
        (-67153187, "Rifle_JumpLand"), (1342791295, "Rifle_JumpMidAir"), (-280994169, "Rifle_JumpStart"), (-239795699, "Rifle_Movement"), (562291691, "Rifle_Recoil"),
        (-1461739520, "Rifle_TurnL"), (1389403491, "Rifle_TurnR"), (1685361460, "SMG_Front_3_Idle"), (-64297445, "SMG_Front_3_Reload"), (2037490572, "SMG_Front_4_Idle"),
        (-152047870, "SMG_Front_4_Reload"), (-881856248, "Short_Shotgun_2_Player_Idle"), (744829067, "Short_Shotgun_2_Player_Reload"), (-1346223135, "Shotgun_front_2_idle"),
        (-1479046558, "Shotgun_front_2_reloadPump"), (902343739, "SledgeHammer_fp_arms"), (-716001131, "Sledgehammer_Charge_Left_Idle"),
        (-1151125288, "Sledgehammer_Charge_Left_Release"), (1925750954, "Sledgehammer_Charge_Left_Start"), (1494636819, "Sledgehammer_Crouch_Shove"),
        (591244724, "Sledgehammer_Idle"), (-473234945, "Sledgehammer_Idle_crouch"), (-1006218459, "Sledgehammer_Stand_Shove"), (760775911, "Sledgehammer_SwingLeft"),
        (1772682815, "Spear_Charge_Left_Idle"), (1545509211, "Spear_Charge_Left_Release"), (995717778, "Spear_Charge_Left_Release_Crouch"),
        (1148653586, "Spear_Charge_Left_Start"), (-755339932, "Spear_Charge_Left_Start_Crouch"), (1429950081, "Spear_Idle"), (1213524166, "Spear_Idle_crouch"),
        (739908351, "Spear_JumpLand"), (989329963, "Spear_JumpStart"), (642796079, "Spear_Movement"), (-38011131, "Spear_SwingLeft"), (-593336433, "Spear_SwingLeft_crouch"),
        (1662624979, "Stock_Pistol_1"), (122605288, "Stock_Pistol_1_reload"), (-1959085039, "Stock_Precision_2"), (-634392596, "TerminalConsole_Idle"),
        (611019729, "Tool_Grip_2"), (85000065, "Tools_Grip_1"), (2022056779, "Turret_Base_1"), (1757887940, "empty"), (1592261978, "fps_hands_idle"),
        (-2073717886, "fps_shoulder_pose"), (564600263, "hackingtool_idle"),
    };

    private static readonly (int Hash, string Name)[] NotSeen =
    {
        (937380992, "Consumable_Mine_Use"), (379251778, "Default_JumpLand"), (-1979073724, "Default_JumpMidAir"), (-1893878292, "Default_JumpStart"),
        (274414215, "Pistol_JumpMidAir"), (-1883503080, "Spear_JumpMidAir"),
    };

    private static readonly Dictionary<int, string> Names = new();
    private static readonly Dictionary<string, int> Hashes = new();

    static BodyStates()
    {
        foreach (var rows in new[] { Seen, NotSeen })
            foreach (var (hash, name) in rows) { Names[hash] = name; Hashes[name] = hash; }
    }

    /// <summary>Every row, for the test that checks the numbers against the names.</summary>
    internal static IEnumerable<(int Hash, string Name)> Rows { get { foreach (var row in Seen) yield return row; foreach (var row in NotSeen) yield return row; } }

    /// <summary>The name of a state number, null for one that is not in the table.</summary>
    internal static string? Name(int hash) => Names.TryGetValue(hash, out var name) ? name : null;

    private static int Of(string name) => Hashes[name];

    // eFullbodyPlayerMovementSet (ItemEquippable.ThirdPersonFullbodyMovement): Rifle, Pistol, Melee, CarryHeavy, Knife, Spear. No logged body carried a heavy item:
    // CarryHeavy is given the controller's Default set, unverified.
    private static readonly string[] Families = { "Rifle", "Pistol", "Melee", "Default", "Knife", "Spear" };

    /// <summary>The movement set's number of the two-handed guns: what a body with nothing wielded yet is given.</summary>
    internal const int RifleFamily = 0;

    private static string Family(int family) => Families[(uint)family < (uint)Families.Length ? family : RifleFamily];

    /// <summary>The full-body state of a player holding an item of movement set <paramref name="family"/> in locomotion state <paramref name="locomotion"/>
    /// (<c>PLOC_State</c>). Standing, crouching and running are one blend tree (the Crouch and walk parameters choose within it). A fall that follows a jump
    /// (<paramref name="jumped"/>) stays in the jump's start, as 310 of 352 logged jumps went from it straight to the landing; a fall off an edge is the mid-air
    /// state. Stunned, a melee lunge and the three grabs were not in any logged game: they stay in the movement state, unverified.</summary>
    internal static int FullBodyState(int family, int locomotion, bool jumped = false) => locomotion switch
    {
        3 => Of(Family(family) + "_JumpStart"),
        4 => Of(Family(family) + (jumped ? "_JumpStart" : "_JumpMidAir")),
        5 => Of(Family(family) + "_JumpLand"),
        7 => Of("Dead"),
        8 => Of("ClimbLadder"),
        9 => Of("TerminalConsole_Idle"),
        15 => Of("ElevatorHangIdle"),
        _ => Of(Family(family) + "_Movement"),
    };

    /// <summary>The aim-offset layer's state and weight (tenths): a gun's aim pose, nothing for the other sets.</summary>
    internal static (int State, int Weight) Aim(int family) => family switch
    {
        0 => (Of("RifleAimOffset"), FullWeight),
        1 => (Of("PistolAimOffset"), FullWeight),
        _ => (Of("RifleAimOffset"), 0),
    };

    /// <summary>The upper-body state a body plays as it brings up inventory slot <paramref name="slot"/> (<c>InventorySlot</c>); 0 for a melee weapon,
    /// whose own names say it (<see cref="MeleeEquip"/>). The names say which slot they are for; the pairing was not checked against a recording.</summary>
    internal static int EquipState(int slot) => slot switch
    {
        1 => Of("EquipPrimary"),
        2 => Of("EquipSecondary"),
        3 => Of("EquipTool"),
        10 => 0,
        _ => Of("EquipGeneric"),
    };

    /// <summary>The names a melee weapon's upper-body states are built from, read off its idle state's name (<c>MeleeAnimationSetDataBlock.TPAnimHashIdle</c>,
    /// "Sledgehammer_Idle"): the game's data names the idle, the swings and the charge but not the equip or the shove.</summary>
    internal static string MeleePrefix(string idleName) => idleName.EndsWith("_Idle", System.StringComparison.Ordinal) ? idleName.Substring(0, idleName.Length - 5) : idleName;

    internal static string MeleeEquip(string idleName) => "Equip" + MeleePrefix(idleName);

    internal static string MeleeShove(string idleName, bool crouched) => MeleePrefix(idleName) + (crouched ? "_Crouch_Shove" : "_Stand_Shove");

    /// <summary>The upper-body state of an interact (<c>pGenericInteractAnimation.TypeEnum</c>): 0 for a shove and a reload, which the wielded item names
    /// (<see cref="MeleeShove"/>, the hand layers). Placing a mine (type 0) was in no logged game: its state is the controller's by name, unverified.</summary>
    internal static int InteractState(int type) => type switch
    {
        0 => Of("Consumable_Mine_Use"),
        1 => Of("Pickup_Low"),
        2 => Of("Pickup_Mid"),
        3 => Of("Pickup_High"),
        4 => Of("Point_Forward"),
        5 => Of("ConsumablePack_Give"),
        6 => Of("ConsumablePack_Take"),
        _ => 0,
    };

    /// <summary>The upper-body state of a throw (<c>pPlayerThrowStatus.StatusEnum</c>: 1 charging, 2 thrown), 0 for none. A fog repeller has states of its own
    /// (Fogrepeller_Throw*), seen three times; which item plays them is not known, so every throw is given the consumable's.</summary>
    internal static int ThrowState(int status) => status switch { 1 => Of("Consumable_Throw_Charge"), 2 => Of("Consumable_Throw"), _ => 0 };
}
