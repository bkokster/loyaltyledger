export function runPlugins(registry, context, helpers) {
    const tasks = registry.plugins
        .filter((plugin) => plugin.shouldHandle(context))
        .map(async (plugin) => {
        const result = await plugin.apply(context, helpers);
        return result;
    });
    return Promise.all(tasks).then((results) => results.filter((r) => r !== null));
}
export async function runRedeemPlugins(registry, context, helpers) {
    for (const plugin of registry.plugins) {
        if (!plugin.shouldHandle(context)) {
            continue;
        }
        const result = await plugin.apply(context, helpers);
        if (result) {
            return result;
        }
    }
    return null;
}
