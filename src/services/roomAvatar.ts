import { Room } from 'matrix-js-sdk'

/**
 * Resolve the avatar to show for a room in lists and notifications.
 *
 * DM rooms rarely carry an m.room.avatar state event, so fall back to the
 * other participant's profile picture. getAvatarFallbackMember() only returns
 * a member when the room has a single other participant, so group rooms keep
 * their own (possibly absent) avatar.
 */
export function getRoomAvatarMxc(room: Room): string | null {
  return room.getMxcAvatarUrl() ?? room.getAvatarFallbackMember()?.getMxcAvatarUrl() ?? null
}
