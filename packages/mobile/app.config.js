const merchantIcon = "./assets/nx-merchant-icon.png";

/**
 * The shared mobile source produces separate Merchant and Official
 * (Rider/Transport) apps. Set NATEX_APP_VARIANT=merchant for Merchant builds;
 * without it, the checked-in NX Official identity remains the default.
 */
module.exports = ({ config }) => {
  const base = config ?? require("./app.json").expo;
  const variant = process.env.NATEX_APP_VARIANT ?? "official";

  if (variant === "official" || variant === "rider") return base;
  if (variant !== "merchant") {
    throw new Error(`Unknown NATEX_APP_VARIANT: ${variant}`);
  }

  return {
    ...base,
    name: "NX Merchant",
    icon: merchantIcon,
    extra: {
      ...base.extra,
      appVariant: "merchant",
    },
    android: {
      ...base.android,
      package: "com.natex.merchant",
      adaptiveIcon: {
        ...base.android?.adaptiveIcon,
        foregroundImage: merchantIcon,
        backgroundColor: "#087C16",
      },
    },
    ios: {
      ...base.ios,
      bundleIdentifier: "com.natex.merchant",
    },
  };
};
