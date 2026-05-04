// ─────────────────────────────────────────────
//  QuranScreen.js — Surah List Browser
//  Entry point for the Quran learning tool
// ─────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { fetchSurahs } from '../services/quranApi';
import { COLORS } from '../constants/theme';

const REVELATION_COLORS = {
  Makkah: '#c9a84c',
  Madinah: '#4c9ac9',
};

export default function QuranScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [surahs, setSurahs] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadSurahs();
  }, []);

  async function loadSurahs() {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchSurahs();
      setSurahs(data);
      setFiltered(data);
    } catch (e) {
      setError('Could not load surahs. Check your connection.');
    } finally {
      setLoading(false);
    }
  }

  const handleSearch = useCallback(
    (text) => {
      setSearch(text);
      if (!text.trim()) {
        setFiltered(surahs);
        return;
      }
      const q = text.toLowerCase();
      setFiltered(
        surahs.filter(
          (s) =>
            s.name_simple.toLowerCase().includes(q) ||
            s.translated_name?.name?.toLowerCase().includes(q) ||
            String(s.id).includes(q)
        )
      );
    },
    [surahs]
  );

  const renderSurah = ({ item }) => (
    <TouchableOpacity
      style={styles.surahRow}
      onPress={() => navigation.navigate('QuranReader', { surah: item })}
      activeOpacity={0.75}
    >
      {/* Number badge */}
      <View style={styles.numberBadge}>
        <Text style={styles.numberText}>{item.id}</Text>
      </View>

      {/* Surah info */}
      <View style={styles.surahInfo}>
        <Text style={styles.surahName}>{item.name_simple}</Text>
        <Text style={styles.surahMeta}>
          {item.translated_name?.name} · {item.verses_count} verses
        </Text>
      </View>

      {/* Arabic name + revelation */}
      <View style={styles.surahRight}>
        <Text style={styles.arabicName}>{item.name_arabic}</Text>
        <Text
          style={[
            styles.revelationType,
            { color: REVELATION_COLORS[item.revelation_place] ?? '#888' },
          ]}
        >
          {item.revelation_place}
        </Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Al-Quran</Text>
          <Text style={styles.headerSub}>Read · Memorize · Recite</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color="#aaa" style={{ marginRight: 8 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search surah name or number..."
          placeholderTextColor="#888"
          value={search}
          onChangeText={handleSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => handleSearch('')}>
            <Ionicons name="close-circle" size={18} color="#aaa" />
          </TouchableOpacity>
        )}
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.gold} size="large" />
          <Text style={styles.loadingText}>Loading surahs...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="wifi-outline" size={48} color="#555" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={loadSurahs}>
            <Text style={styles.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderSurah}
          contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#000',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  headerSub: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 2,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    margin: 12,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    color: '#000',
    fontSize: 14,
    padding: 0,
  },
  surahRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  numberBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  numberText: {
    color: COLORS.gold ?? '#c9a84c',
    fontSize: 13,
    fontWeight: '700',
  },
  surahInfo: {
    flex: 1,
  },
  surahName: {
    color: '#000',
    fontSize: 15,
    fontWeight: '600',
  },
  surahMeta: {
    color: '#666',
    fontSize: 12,
    marginTop: 3,
  },
  surahRight: {
    alignItems: 'flex-end',
  },
  arabicName: {
    color: '#000',
    fontSize: 18,
    fontWeight: '500',
  },
  revelationType: {
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginHorizontal: 16,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: '#666',
    fontSize: 14,
    marginTop: 12,
  },
  errorText: {
    color: '#666',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 32,
    marginBottom: 12,
  },
  retryBtn: {
    marginTop: 12,
    backgroundColor: COLORS.gold ?? '#c9a84c',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  retryText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 14,
  },
});
