const ROLE_LEVELS = Object.freeze({viewer:0, moderator:1, broadcaster:2});
function getPermissions(tags) {
    const isBroadcaster = tags.badges?.broadcaster === '1';
    const isMod = tags.mod === true || isBroadcaster;
    const isVIP = tags.badges?.vip === '1';
    return {isBroadcaster, isMod, isVIP, role:isBroadcaster ? 'broadcaster' : isMod ? 'moderator' : 'viewer', exemptFromAutoModeration:isMod || isVIP};
}
function canExecute(requiredRole, permissions) {
    return Object.hasOwn(ROLE_LEVELS, requiredRole) &&
        Object.hasOwn(ROLE_LEVELS, permissions.role) &&
        ROLE_LEVELS[permissions.role] >= ROLE_LEVELS[requiredRole];
}
module.exports = {getPermissions, canExecute};
