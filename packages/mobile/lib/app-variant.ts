import Constants from "expo-constants";

export const isMerchantApp = Constants.expoConfig?.extra?.appVariant === "merchant";
export const appDisplayName = isMerchantApp ? "NatEx Merchant" : "NX Official";
