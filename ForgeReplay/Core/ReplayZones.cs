using System;
using ForgeUI;

namespace ForgeReplay;

/// <summary>The replay screen's fixed zones on the current screen, none over another, all along the edges so the middle of the picture stays
/// clear: the time bar's plate across the bottom; above it, outside the plate, one row with the panel tabs on the left, the watched player's line
/// in the middle and the views on the right; over that row the left column (the mission card) and the right column (the screen's buttons in the top
/// corner, the player cards under them, and under the cards the key hints, one row right over the views, against the right edge); between the columns the middle for the game's own lines, scans and notices. The panels stand
/// above the tabs, from the left edge to the cards (<see cref="Panels"/>); an open panel makes the middle give way (ReplayScreen).</summary>
internal readonly record struct ReplayZones(HudBox Work, HudBox Bottom, HudBox Mission, HudBox Tabs, HudBox Corner, HudBox Cards, HudBox Hints, HudBox Views, HudBox Middle)
{
    private const float SideShare = 0.26f, SideMin = 420f, SideMax = 760f;

    /// <param name="screen">The screen's edges.</param>
    /// <param name="margin">The player's safe margin.</param>
    /// <param name="bar">The time bar's height from the bottom edge (safe margin included).</param>
    /// <param name="row">The height of a row of buttons: the corner, the tabs, the views (with the watched player's line) and the hints are each one row.</param>
    /// <param name="tabsWidth">How wide the panel tabs want to be (never wider than the side share of the screen).</param>
    /// <param name="gap">The space between zones.</param>
    /// <param name="cardWidth">How wide the cards want to be (never wider than the side share of the screen).</param>
    internal static ReplayZones Of(HudBox screen, float margin, float bar, float row, float gap, float cardWidth, float tabsWidth)
    {
        var left = screen.Left + margin;
        var right = screen.Right - margin;
        var bottom = new HudBox(left, screen.Bottom + margin, right, screen.Bottom + bar);
        var work = new HudBox(left, bottom.Top + gap, right, screen.Top - margin);
        var side = Math.Clamp(work.Width * SideShare, Math.Min(SideMin, work.Width / 3f), SideMax);
        var corner = new HudBox(right - side, work.Top - row, right, work.Top);
        var hints = new HudBox(right - side, work.Bottom + row + gap, right, work.Bottom + 2f * row + gap);
        var cards = new HudBox(right - Math.Min(cardWidth, side), hints.Top + gap, right, corner.Bottom - gap);
        var tabs = new HudBox(left, work.Bottom, left + Math.Min(tabsWidth, side), work.Bottom + row);
        var mission = new HudBox(left, tabs.Top + gap, left + side, work.Top);
        var views = new HudBox(tabs.Right + gap, work.Bottom, right, work.Bottom + row);
        var middle = new HudBox(mission.Right + gap, views.Top + gap, corner.Left - gap, work.Top);
        return new ReplayZones(work, bottom, mission, tabs, corner, cards, hints, views, middle);
    }

    /// <summary>The room for a panel when the mission card ends at <paramref name="top"/>: above the tabs, left of the cards.</summary>
    internal HudBox Panels(float top, float gap) => new(Work.Left, Tabs.Top + gap, Cards.Left - gap, top);
}
