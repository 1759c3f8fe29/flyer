import React, { useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme/ThemeProvider';
import {
  captureWithCamera,
  pickFromLibrary,
  type PickedMedia,
} from '@/src/services/MediaManager';
import { Icon, type IconName } from './Icon';
import { Pressable } from './Pressable';

interface Props {
  visible: boolean;
  onClose: () => void;
  onPicked: (media: PickedMedia[]) => void;
}

/**
 * Attachment sheet. Only the four supported kinds are offered — there is
 * deliberately no document/file option, per the product constraint.
 */
export function AttachSheet({ visible, onClose, onPicked }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<PickedMedia[]>) => {
    setBusy(true);
    try {
      const media = await fn();
      onPicked(media);
    } catch (e) {
      console.warn('[Flyer/attach] picker failed', e);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const options: {
    icon: IconName;
    label: string;
    color: string;
    action: () => Promise<PickedMedia[]>;
  }[] = [
    {
      icon: 'camera',
      label: 'Camera',
      color: '#E8788A',
      action: async () => {
        const shot = await captureWithCamera('image');
        return shot ? [shot] : [];
      },
    },
    {
      icon: 'video',
      label: 'Record',
      color: '#B58BD8',
      action: async () => {
        const clip = await captureWithCamera('video');
        return clip ? [clip] : [];
      },
    },
    {
      icon: 'copy',
      label: 'Photos',
      color: '#7C9CF0',
      action: () => pickFromLibrary('image'),
    },
    {
      icon: 'play',
      label: 'Videos',
      color: '#63C2A0',
      action: () => pickFromLibrary('video'),
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.bgElevated,
              paddingBottom: Math.max(insets.bottom, 18) + 16,
            },
          ]}
          onPress={() => {}}
        >
          <View style={[styles.grabber, { backgroundColor: theme.colors.border }]} />

          {busy ? (
            <View style={styles.busy}>
              <ActivityIndicator color={theme.colors.accent} />
              <Text style={[styles.busyText, { color: theme.colors.textMuted }]}>
                Preparing media…
              </Text>
            </View>
          ) : (
            <View style={styles.grid}>
              {options.map((option) => (
                <Pressable
                  key={option.label}
                  style={styles.option}
                  haptic
                  onPress={() => run(option.action)}
                >
                  <View style={[styles.bubble, { backgroundColor: option.color }]}>
                    <Icon name={option.icon} size={24} color="#FFFFFF" />
                  </View>
                  <Text style={[styles.optionLabel, { color: theme.colors.textMuted }]}>
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 18,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-around' },
  option: { alignItems: 'center', width: '25%', marginBottom: 10 },
  bubble: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 7,
  },
  optionLabel: { fontSize: 12 },
  busy: { alignItems: 'center', paddingVertical: 34, gap: 10 },
  busyText: { fontSize: 13 },
});
