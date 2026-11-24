import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { randomUUID } from "expo-crypto";
import { client } from "./api";

const TASK = "natex-rider-gps";
const QUEUE_KEY = "natex:rider:gps:queue";
const ACTIVE_KEY = "natex:rider:gps:active";

type QueuedPoint = { clientPointId: string; capturedAt: string; latitude: number; longitude: number; accuracyMeters: number; speedMps: number };

async function readQueue(): Promise<QueuedPoint[]> {
  try { return JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? "[]") as QueuedPoint[]; } catch { return []; }
}
async function appendLocations(locations: Location.LocationObject[]) {
  const current = await readQueue();
  const next = [...current, ...locations.map((location) => ({ clientPointId: randomUUID(), capturedAt: new Date(location.timestamp).toISOString(), latitude: location.coords.latitude, longitude: location.coords.longitude, accuracyMeters: location.coords.accuracy ?? 9999, speedMps: Math.max(0, location.coords.speed ?? 0) }))];
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(next.slice(-2000)));
}

if (!TaskManager.isTaskDefined(TASK)) {
  TaskManager.defineTask(TASK, async ({ data, error }) => {
    if (error || !data) return;
    const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
    if (locations.length) await appendLocations(locations);
  });
}

export async function startRiderGps(): Promise<{ enabled: boolean; message?: string }> {
  if (Platform.OS === "web") return { enabled: false, message: "GPS tracking is available on the mobile device." };
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== "granted") return { enabled: false, message: "Enable GPS permission to record your route." };
  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== "granted") return { enabled: false, message: "Allow background GPS so your route continues while the app is not open." };
  await AsyncStorage.setItem(ACTIVE_KEY, "1");
  await Location.startLocationUpdatesAsync(TASK, { accuracy: Location.Accuracy.Balanced, timeInterval: 30000, distanceInterval: 50, showsBackgroundLocationIndicator: true, foregroundService: { notificationTitle: "NatEx route tracking", notificationBody: "Your rider route is being recorded while clocked in." } });
  return { enabled: true };
}

export async function stopRiderGps(): Promise<void> {
  await AsyncStorage.removeItem(ACTIVE_KEY);
  if (Platform.OS !== "web" && await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
}

export async function flushRiderGps(workDate?: string) {
  if (Platform.OS === "web") return { accepted: 0, rejected: 0, distanceMeters: 0 };
  const queue = await readQueue();
  if (!queue.length) return { accepted: 0, rejected: 0, distanceMeters: 0 };
  const batch = queue.slice(0, 500);
  const result = await client.riderGps.points({ workDate, points: batch });
  const remaining = queue.slice(batch.length);
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  return result;
}

export async function clearRiderGpsQueue() { await AsyncStorage.removeItem(QUEUE_KEY); }
