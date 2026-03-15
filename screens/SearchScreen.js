import { View, Text, StyleSheet, TextInput, FlatList, ActivityIndicator, Image } from 'react-native';
import { useState, useRef, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { COLORS } from '../constants/theme';

const CATEGORIES = ['All', 'Quran', 'Hadith', 'Reminder', 'Lecture', 'Nasheeds', 'Dua', 'Other'];

export default function SearchScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const flatListRef = useRef(null);
  const searchTimeout = useRef(null);
  const renderResultItem = useCallback(({ item }) => (
    <AnimatedButton onPress={() => navigation.navigate('VideoDetail', { video: item })} style={styles.resultCard}>
      <View style={styles.resultThumbnail}>
        {item.thumbnail_url || item.video_url ? (
          <Image
            source={{ uri: item.thumbnail_url || item.video_url }}
            style={{ width: 64, height: 64, borderRadius: 10 }}
            resizeMode="cover"
          />
        ) : (
          <Text style={styles.resultThumbnailIcon}>🎬</Text>
        )}
      </View>
      <View style={styles.resultInfo}>
        <Text style={styles.resultCaption} numberOfLines={2}>{item.caption}</Text>
        <View style={styles.resultMeta}>
          <View style={styles.categoryTag}><Text style={styles.categoryTagText}>{item.category}</Text></View>
          <Text style={styles.resultViews}>{item.views_count ?? 0} views</Text>
        </View>
      </View>
    </AnimatedButton>
  ), [navigation]);

  useFocusEffect(
    useCallback(() => {
      flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    }, [])
  );

  const handleSearch = useCallback((text) => {
      setQuery(text);
      if (text.trim().length < 2) { setResults([]); return; }
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      searchTimeout.current = setTimeout(async () => {
        setLoading(true);
        const sanitized = text.replace(/[%_\\]/g, '\\$&').trim();
        let query = supabase.from('videos').select('*').ilike('caption', `%${sanitized}%`);
        if (selectedCategory !== 'All') query = query.eq('category', selectedCategory);
        const { data, error } = await query.limit(20);
        if (error) { console.warn('Search error:', error.message); setResults([]); setLoading(false); return; }
        setResults(data ?? []);
        setLoading(false);
      }, 400);
    }, [selectedCategory]);

  const handleCategory = useCallback(async (cat) => {
    setSelectedCategory(cat);
    setLoading(true);
    if (cat === 'All') {
      const { data, error } = await supabase.from('videos').select('*').limit(20);
      if (error) { console.warn('Category error:', error.message); setResults([]); setLoading(false); return; }
      setResults(data ?? []);
    } else {
      const { data } = await supabase.from('videos').select('*').eq('category', cat).limit(20);
      setResults(data ?? []);
    }
    setLoading(false);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { paddingTop: insets.top + 16 }]}>Search</Text>

      <View style={styles.searchBar}>
        <Text style={styles.searchIcon}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Search videos, scholars..."
          placeholderTextColor="#aaaaaa"
          value={query}
          onChangeText={handleSearch}
        />
        {query.length > 0 && (
          <AnimatedButton onPress={() => { setQuery(''); setResults([]); }}>
            <Text style={styles.clearBtn}>✕</Text>
          </AnimatedButton>
        )}
      </View>

      <FlatList
        data={CATEGORIES}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item}
        style={styles.categoryList}
        renderItem={({ item }) => (
          <AnimatedButton
            style={[styles.categoryChip, selectedCategory === item && styles.categoryChipActive]}
            onPress={() => handleCategory(item)}
          >
            <Text style={[styles.categoryChipText, selectedCategory === item && styles.categoryChipTextActive]}>{item}</Text>
          </AnimatedButton>
        )}
      />

      {loading ? (
        <ActivityIndicator color={COLORS.gold} size="large" style={styles.loader} />
      ) : results.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🕌</Text>
          <Text style={styles.emptyText}>{query.length > 0 ? 'No videos found' : 'Search for Islamic content'}</Text>
          <Text style={styles.emptySubtext}>{query.length > 0 ? 'Try different keywords' : 'or browse by category above'}</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.resultsList}
          removeClippedSubviews={true}
          maxToRenderPerBatch={6}
          windowSize={5}
          renderItem={renderResultItem}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  title: { fontSize: 24, fontWeight: '700', color: '#111111', paddingHorizontal: 16, marginBottom: 16 },
  searchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f5f5f5', borderRadius: 12, marginHorizontal: 16, paddingHorizontal: 12, marginBottom: 16, borderWidth: 0.5, borderColor: '#e5e5e5' },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, color: '#111111', fontSize: 15, paddingVertical: 14 },
  clearBtn: { color: '#aaaaaa', fontSize: 16, padding: 4 },
  categoryList: { paddingHorizontal: 16, marginBottom: 16, flexGrow: 0 },
  categoryChip: { backgroundColor: '#f5f5f5', borderWidth: 0.5, borderColor: '#e5e5e5', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8 },
  categoryChipActive: { backgroundColor: COLORS.gold, borderColor: COLORS.gold },
  categoryChipText: { color: '#888888', fontSize: 13, fontWeight: '600' },
  categoryChipTextActive: { color: '#ffffff' },
  loader: { marginTop: 60 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyText: { color: '#111111', fontSize: 16, fontWeight: '600', marginBottom: 6 },
  emptySubtext: { color: '#888888', fontSize: 14 },
  resultsList: { paddingHorizontal: 16, paddingBottom: 40 },
  resultCard: { flexDirection: 'row', backgroundColor: '#f5f5f5', borderRadius: 12, padding: 12, marginBottom: 10, gap: 12, alignItems: 'center', borderWidth: 0.5, borderColor: '#e5e5e5' },
  resultThumbnail: { width: 64, height: 64, borderRadius: 10, backgroundColor: '#e5e5e5', alignItems: 'center', justifyContent: 'center' },
  resultThumbnailIcon: { fontSize: 28 },
  resultInfo: { flex: 1 },
  resultCaption: { color: '#111111', fontSize: 14, fontWeight: '600', marginBottom: 8, lineHeight: 20 },
  resultMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  categoryTag: { backgroundColor: `${COLORS.gold}20`, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  categoryTagText: { color: COLORS.goldDark, fontSize: 11, fontWeight: '700' },
  resultViews: { color: '#888888', fontSize: 12 },
});