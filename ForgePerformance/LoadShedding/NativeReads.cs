using System;
using System.Runtime.InteropServices;
using CullingSystem;
using Il2CppInterop.Runtime;
using Il2CppInterop.Runtime.InteropTypes;
using UnityEngine;

namespace ForgePerformance.LoadShedding;

// The per-frame decoration paths read game fields in place, at offsets resolved once by name. Each read gives the
// same value as the interop property it replaces (which looks the offset up again on every read), and a list item
// read gives the item's pointer without the interop call and the new wrapper the indexer makes.
internal static class NativeList<T> where T : Il2CppObjectBase
{
    private static readonly IntPtr Class = Il2CppClassPointerStore<Il2CppSystem.Collections.Generic.List<T>>.NativeClassPtr;
    private static readonly int Items = NativeReads.Offset(Class, "_items"), Size = NativeReads.Offset(Class, "_size"),
        Version = NativeReads.Offset(Class, "_version");

    internal static int Count(IntPtr list) => Marshal.ReadInt32(list, Size);
    internal static int VersionOf(IntPtr list) => Marshal.ReadInt32(list, Version);
    // An element of a reference array, below Count: IntPtr.Zero where the list holds null.
    internal static IntPtr Item(IntPtr list, int index)
        => Marshal.ReadIntPtr(Marshal.ReadIntPtr(list, Items), NativeReads.ArrayHeader + index * IntPtr.Size);
}

internal static class NativeReads
{
    // Il2CppArray: object header (class, monitor), bounds, max_length, then the elements.
    internal static readonly int ArrayHeader = 4 * IntPtr.Size;

    private static readonly IntPtr Cullable = Il2CppClassPointerStore<C_Cullable>.NativeClassPtr;
    private static readonly int Registered = Offset(Cullable, "IsRegistered"), Shown = Offset(Cullable, "IsShown"),
        CullBounds = Offset(Cullable, "Bounds");

    internal static bool IsRegistered(C_Cullable cullable) => Marshal.ReadByte(cullable.Pointer, Registered) != 0;
    internal static bool IsShown(C_Cullable cullable) => Marshal.ReadByte(cullable.Pointer, Shown) != 0;
    internal static unsafe Bounds Bounds(C_Cullable cullable) => *(Bounds*)(cullable.Pointer + CullBounds);

    internal static int Offset(IntPtr type, string name)
    {
        var field = type == IntPtr.Zero ? IntPtr.Zero : IL2CPP.GetIl2CppField(type, name);
        if (field == IntPtr.Zero) throw new MissingFieldException("Load shedding native field missing: " + name);
        return checked((int)IL2CPP.il2cpp_field_get_offset(field));
    }
}
