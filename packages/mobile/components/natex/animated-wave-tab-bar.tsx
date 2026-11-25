import type { BottomTabBarProps } from "expo-router/build/react-navigation/bottom-tabs";
import { useEffect, useState } from "react";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Fonts } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const BAR_CONTENT_HEIGHT = 50;
const TOP_EDGE_Y = 11;
const BUMP_PEAK_Y = 1;

function makeWavePath(width: number, height: number, count: number, index: number) {
  "worklet";
  if (!width || !height || !count) return "";

  const bottom = height - 3;
  const radius = Math.min(18, bottom / 2);
  const step = width / count;
  const halfBump = Math.min(23, step * 0.31);
  const center = Math.max(radius + halfBump, Math.min(width - radius - halfBump, (index + 0.5) * step));
  const left = center - halfBump;
  const right = center + halfBump;

  return [
    `M ${radius} ${TOP_EDGE_Y}`,
    `L ${left} ${TOP_EDGE_Y}`,
    `C ${left + halfBump * 0.52} ${TOP_EDGE_Y} ${center - halfBump * 0.43} ${BUMP_PEAK_Y} ${center} ${BUMP_PEAK_Y}`,
    `C ${center + halfBump * 0.43} ${BUMP_PEAK_Y} ${right - halfBump * 0.52} ${TOP_EDGE_Y} ${right} ${TOP_EDGE_Y}`,
    `L ${width - radius} ${TOP_EDGE_Y}`,
    `Q ${width} ${TOP_EDGE_Y} ${width} ${TOP_EDGE_Y + radius}`,
    `L ${width} ${bottom - radius}`,
    `Q ${width} ${bottom} ${width - radius} ${bottom}`,
    `L ${radius} ${bottom}`,
    `Q 0 ${bottom} 0 ${bottom - radius}`,
    `L 0 ${TOP_EDGE_Y + radius}`,
    `Q 0 ${TOP_EDGE_Y} ${radius} ${TOP_EDGE_Y}`,
    "Z",
  ].join(" ");
}

function WaveTabItem({
  route,
  index,
  selectedIndex,
  focused,
  label,
  icon,
  activeColor,
  inactiveColor,
  onPress,
  onLongPress,
  accessibilityLabel,
  testID,
}: {
  route: BottomTabBarProps["state"]["routes"][number];
  index: number;
  selectedIndex: SharedValue<number>;
  focused: boolean;
  label: string;
  icon: React.ReactNode;
  activeColor: ColorValue;
  inactiveColor: ColorValue;
  onPress: () => void;
  onLongPress: () => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const distance = Math.abs(selectedIndex.value - index);
    return {
      opacity: interpolate(distance, [0, 1, 3], [1, 0.62, 0.52], Extrapolation.CLAMP),
      transform: [
        {
          translateY: interpolate(distance, [0, 1], [-7, 0], Extrapolation.CLAMP),
        },
      ],
    };
  }, [index]);

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      onLongPress={onLongPress}
      onPress={onPress}
      style={styles.tab}
      testID={testID}
    >
      <Animated.View style={[styles.tabContent, animatedStyle]}>
        <View style={styles.icon}>{icon}</View>
        <Text
          numberOfLines={1}
          style={[
            styles.label,
            {
              color: focused ? activeColor : inactiveColor,
              fontFamily: focused ? Fonts.bodyMedium : Fonts.body,
            },
          ]}
        >
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/** A shared pill-shaped wave tab bar for the rider, transport and merchant workspaces. */
export function AnimatedWaveTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const colors = useColors();
  const safeArea = useSafeAreaInsets();
  const width = useSharedValue(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const selectedIndex = useSharedValue(Math.max(0, state.index));
  // Android edge-to-edge devices can report zero from React Navigation while
  // still drawing the three-button/gesture navigation area over the app.
  // Lift the entire bar above that area and keep a small, predictable gap.
  const safeBottom = Math.max(insets.bottom, safeArea.bottom, Platform.OS === "android" ? 24 : 0);
  const height = BAR_CONTENT_HEIGHT;

  const routes = state.routes.filter((route) => {
    const options = descriptors[route.key].options;
    const tabBarStyle = StyleSheet.flatten(options.tabBarStyle as StyleProp<ViewStyle>);
    return (
      StyleSheet.flatten(options.tabBarItemStyle)?.display !== "none" &&
      tabBarStyle?.display !== "none"
    );
  });
  const currentRoute = state.routes[state.index];
  const currentOptions = currentRoute ? descriptors[currentRoute.key].options : undefined;
  const currentTabBarStyle = currentOptions
    ? StyleSheet.flatten(currentOptions.tabBarStyle as StyleProp<ViewStyle>)
    : undefined;
  const hiddenRoute = currentOptions
    ? StyleSheet.flatten(currentOptions.tabBarItemStyle)?.display === "none" ||
      currentTabBarStyle?.display === "none"
    : false;
  const activeIndex = routes.findIndex((route) => route.key === currentRoute?.key);
  const targetIndex = activeIndex < 0 ? 0 : activeIndex;

  useEffect(() => {
    selectedIndex.value = withTiming(targetIndex, {
      duration: 360,
      easing: Easing.inOut(Easing.cubic),
    });
  }, [selectedIndex, targetIndex]);

  const waveProps = useAnimatedProps(() => ({
    d: makeWavePath(width.value, height, routes.length, selectedIndex.value),
  }));

  const onLayout = (event: { nativeEvent: { layout: { width: number } } }) => {
    const nextWidth = event.nativeEvent.layout.width;
    width.value = nextWidth;
    setContainerWidth(nextWidth);
  };

  if (hiddenRoute || routes.length === 0) return null;

  return (
    <View onLayout={onLayout} style={[styles.container, { height, marginBottom: safeBottom, backgroundColor: colors.card }]}>
      <Svg
        height={height}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
        viewBox={`0 0 ${Math.max(containerWidth, 1)} ${height}`}
        width="100%"
      >
        <AnimatedPath
          animatedProps={waveProps}
          fill={colors.surface}
          opacity={0.14}
          stroke={colors.primary}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={7}
        />
        <AnimatedPath
          animatedProps={waveProps}
          fill={colors.surface}
          stroke={colors.primary}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.4}
        />
      </Svg>
      <View style={[styles.row, { height }]}>
        {routes.map((route) => {
          const routeIndex = routes.findIndex((candidate) => candidate.key === route.key);
          const focused = route.key === currentRoute?.key;
          const { options } = descriptors[route.key];
          const label =
            typeof options.tabBarLabel === "string"
              ? options.tabBarLabel
              : typeof options.title === "string"
                ? options.title
                : route.name;
          const activeColor = options.tabBarActiveTintColor ?? colors.primary;
          const inactiveColor = options.tabBarInactiveTintColor ?? colors.mutedForeground;
          const icon = options.tabBarIcon?.({
            focused,
            color: focused ? activeColor : inactiveColor,
            size: 23,
          });

          return (
            <WaveTabItem
              accessibilityLabel={options.tabBarAccessibilityLabel ?? `${label}, tab`}
              activeColor={activeColor}
              focused={focused}
              icon={icon}
              inactiveColor={inactiveColor}
              index={routeIndex}
              key={route.key}
              label={label}
              onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
              onPress={() => {
                const event = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!focused && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              }}
              route={route}
              selectedIndex={selectedIndex}
              testID={options.tabBarButtonTestID}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "transparent",
    elevation: 18,
    zIndex: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.14)",
    overflow: "visible",
    width: "100%",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    paddingHorizontal: 5,
  },
  tab: {
    alignItems: "center",
    flex: 1,
    height: BAR_CONTENT_HEIGHT - 1,
    justifyContent: "center",
  },
  tabContent: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: 48,
  },
  icon: {
    alignItems: "center",
    height: 20,
    justifyContent: "center",
  },
  label: {
    fontSize: 10,
    lineHeight: 12,
  },
});
