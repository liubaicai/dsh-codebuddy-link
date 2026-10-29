const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value) => value == null || typeof value === 'string';
const meta = (value) => value._meta == null || object(value._meta);
const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const option = (value) => object(value) && meta(value) && typeof value.value === 'string'
    && typeof value.name === 'string' && optionalString(value.description);
const group = (value) => object(value) && meta(value) && typeof value.group === 'string'
    && typeof value.name === 'string' && Array.isArray(value.options) && value.options.every(option);
const config = (value) => {
    if (!object(value) || !meta(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
        || !optionalString(value.description) || !optionalString(value.category))
        return false;
    if (value.type === 'boolean')
        return typeof value.currentValue === 'boolean';
    return value.type === 'select' && typeof value.currentValue === 'string' && Array.isArray(value.options)
        && (value.options.every(option) || value.options.every(group));
};
/**
 * Non-executing ACP session metadata may precede session/new's response or
 * follow session/prompt's response.
 * Keep this allowlist explicit: message/tool/plan events are not metadata, and
 * unknown updates must not silently acquire permission to cross that boundary.
 * Shapes follow the ACP SessionUpdate schema; extension payloads stay opaque.
 */
export function isSessionMetadata(row) {
    if (!meta(row))
        return false;
    switch (row.sessionUpdate) {
        case 'session_info_update':
            return optionalString(row.title) && optionalString(row.updatedAt);
        case 'current_mode_update':
            return typeof row.currentModeId === 'string';
        case 'config_option_update':
            return Array.isArray(row.configOptions) && row.configOptions.every(config);
        case 'available_commands_update':
            return Array.isArray(row.availableCommands) && row.availableCommands.every(command => object(command)
                && meta(command) && typeof command.name === 'string' && typeof command.description === 'string'
                && (command.input == null || (object(command.input) && meta(command.input) && typeof command.input.hint === 'string')));
        case 'usage_update':
            return count(row.used) && count(row.size) && (row.cost == null || (object(row.cost) && meta(row.cost)
                && typeof row.cost.amount === 'number' && Number.isFinite(row.cost.amount) && typeof row.cost.currency === 'string'));
        default:
            return false;
    }
}
//# sourceMappingURL=acp-messages.js.map