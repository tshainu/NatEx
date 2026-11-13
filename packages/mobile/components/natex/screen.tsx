import React from "react";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { Display, Small } from "./text";
import { WorkspaceSwitcher } from "./workspace-switcher";

/**
 * The screen shell every field screen uses.
 *
 * design.md, "Mobile (Expo)": the primary action is a full-width 56px button
 * pinned to the bottom of the screen. That is what `footer` is for — it sits
 * outside the scroll view so it never scrolls away mid-scan, and the scroll
 * content gets padding so the last row is never trapped behind it.
 */

interface ScreenProps {
  children: React.ReactNode;
  /** Pinned bottom action area — thumb-first primary button lives here. */
  footer?: React.ReactNode;
  /** Set when this screen is inside a tab navigator (the tab bar owns the bottom inset). */
  inTabs?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Turn the scroll view off for screens that own their own list. */
  scroll?: boolean;
}

export function Screen({
  children,
  footer,
  inTabs = false,
  onRefresh,
  refreshing = false,
  scroll = true,
}: ScreenProps) {
  const colors = useColors();
  const [footerHeight, setFooterHeight] = React.useState(0);
  const edges = inTabs
    ? (["top", "left", "right"] as const)
    : (["top", "left", "right", "bottom"] as const);

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.content,
        footer ? styles.contentWithFooter : null,
        footer && footerHeight ? { paddingBottom: footerHeight + Space.page } : null,
      ]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={styles.flex}>{children}</View>
  );

  return (
    <SafeAreaView edges={edges} style={[styles.flex, { backgroundColor: colors.background }]}>
      <View style={styles.flex}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          {body}
        </KeyboardAvoidingView>
        {footer ? (
          <View
            onLayout={(event) => {
              const nextHeight = Math.ceil(event.nativeEvent.layout.height);
              setFooterHeight((current) => current === nextHeight ? current : nextHeight);
            }}
            style={[styles.footer, { backgroundColor: colors.card, borderTopColor: colors.border }]}
          >
            {footer}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

/** Screen title block: what this screen is, and the one line of context under it. */
export function ScreenHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.header}>
      <WorkspaceSwitcher />
      <View style={styles.flex}>
        <Display>{title}</Display>
        {subtitle ? <Small style={styles.headerSubtitle}>{subtitle}</Small> : null}
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

/** A labelled group of rows, with 8px-grid spacing above it. */
export function Section({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.ComponentProps<typeof View>["style"];
}) {
  return <View style={[styles.section, style]}>{children}</View>;
}

export function Divider() {
  const colors = useColors();
  return <View style={[styles.divider, { backgroundColor: colors.border }]} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Space.page,
    paddingTop: Space.page,
    paddingBottom: Space.page * 2,
    gap: Space.unit * 2,
  },
  contentWithFooter: {
    // Fallback before the pinned footer's first onLayout measurement.
    paddingBottom: Space.primaryButtonHeight * 2 + Space.page * 3,
  },
  footer: {
    padding: Space.page,
    paddingTop: Space.unit * 1.5,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Space.unit,
    ...Platform.select({
      web: { boxShadow: "0px -4px 14px rgba(0,0,0,0.12)" },
      default: {
        elevation: 8,
        shadowColor: "#000000",
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.12,
        shadowRadius: 14,
      },
    }),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: Space.unit * 1.5,
    marginBottom: 2,
  },
  headerSubtitle: { marginTop: 4 },
  headerRight: { alignItems: "flex-end" },
  section: { gap: Space.unit * 0.75 },
  divider: { height: StyleSheet.hairlineWidth, opacity: 0.8 },
});
