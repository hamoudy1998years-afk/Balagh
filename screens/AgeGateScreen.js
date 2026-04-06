import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  FlatList,
  Dimensions,
  StatusBar,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SystemBars } from 'react-native-edge-to-edge';

const { height } = Dimensions.get('window');
const ITEM_HEIGHT = 80;
const MIN_AGE = 13;
const VISIBLE_ITEMS = 5;

export default function AgeGateScreen({ onVerified }) {
  const insets = useSafeAreaInsets();
  
  useEffect(() => {
    StatusBar.setBarStyle('light-content', true);
    if (Platform.OS === 'android') {
      StatusBar.setTranslucent(true);
      StatusBar.setBackgroundColor('transparent');
    }
  }, []);
  
  const [selectedAge, setSelectedAge] = useState(18);
  const flatListRef = useRef(null);
  
  const ages = Array.from({ length: 88 }, (_, i) => i + 13); // 13 to 100

  const onScroll = useCallback((event) => {
    const y = event.nativeEvent.contentOffset.y;
    const index = Math.round(y / ITEM_HEIGHT);
    if (ages[index]) {
      setSelectedAge(ages[index]);
    }
  }, []);

  const scrollToAge = (age) => {
    const index = ages.indexOf(age);
    flatListRef.current?.scrollToOffset({
      offset: index * ITEM_HEIGHT,
      animated: true,
    });
  };

  const handleContinue = async () => {
    if (selectedAge < MIN_AGE) {
      Alert.alert(
        'Age Requirement',
        'You must be at least 13 years old to use Balagh.',
        [{ text: 'OK' }]
      );
      return;
    }

    await AsyncStorage.setItem('ageVerified', 'true');
    await AsyncStorage.setItem('userAge', selectedAge.toString());
    onVerified();
  };

  const renderItem = useCallback(({ item, index }) => {
    const distance = Math.abs(item - selectedAge);
    const isSelected = item === selectedAge;

    let fontSize = 14;
    let color = '#222';
    let opacity = 0.15;
    let fontWeight = '400';
    let scale = 0.7;

    if (distance === 0) {
      fontSize = 38;
      color = '#ffffff';
      opacity = 1;
      fontWeight = '800';
      scale = 1;
    } else if (distance === 1) {
      fontSize = 26;
      color = '#aaaaaa';
      opacity = 0.7;
      fontWeight = '600';
      scale = 0.9;
    } else if (distance === 2) {
      fontSize = 19;
      color = '#666666';
      opacity = 0.4;
      fontWeight = '400';
      scale = 0.8;
    } else {
      fontSize = 14;
      color = '#333333';
      opacity = 0.15;
      fontWeight = '400';
      scale = 0.7;
    }

    return (
      <TouchableOpacity
        style={styles.ageItem}
        onPress={() => scrollToAge(item)}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.ageText,
            {
              fontSize,
              color,
              opacity,
              fontWeight,
              transform: [{ scale }],
            },
          ]}
        >
          {item}
        </Text>
        {isSelected && <View style={styles.indicator} />}
      </TouchableOpacity>
    );
  }, [selectedAge]);

  const getItemLayout = useCallback((_, index) => ({
    length: ITEM_HEIGHT,
    offset: ITEM_HEIGHT * index,
    index,
  }), []);

  const initialScrollIndex = ages.indexOf(18);

  return (
    <View style={styles.container}>
      <SystemBars style="light" />
      <View style={[styles.header, { paddingTop: insets.top + 20 }]}>
        <Text style={styles.emoji}></Text>
        <Text style={styles.title}>How old are you?</Text>
        <Text style={styles.subtitle}>
          Please select your age to continue
        </Text>
      </View>

      <View style={styles.pickerContainer}>
        {/* Top fade gradient */}
        <View style={styles.fadeTop} />
        
        {/* Center selection line */}
        <View style={styles.centerLine} />
        <View style={styles.centerLineBottom} />
        
        <FlatList
          ref={flatListRef}
          data={ages}
          renderItem={renderItem}
          keyExtractor={(item) => item.toString()}
          getItemLayout={getItemLayout}
          showsVerticalScrollIndicator={false}
          snapToInterval={ITEM_HEIGHT}
          decelerationRate="fast"
          disableIntervalMomentum={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          initialScrollIndex={initialScrollIndex}
          contentContainerStyle={{
            paddingTop: (height * 0.35) - (ITEM_HEIGHT * 2) + insets.top,
            paddingBottom: (height * 0.35) - (ITEM_HEIGHT * 2) + insets.bottom,
          }}
        />
        
        {/* Bottom fade gradient */}
        <View style={styles.fadeBottom} />
      </View>

      <View style={styles.selectedDisplay}>
        <Text style={styles.selectedLabel}>Selected</Text>
        <Text style={styles.selectedValue}>{selectedAge} years old</Text>
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
        <TouchableOpacity
          style={styles.button}
          onPress={handleContinue}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>Continue</Text>
        </TouchableOpacity>

        <Text style={styles.terms}>
          By continuing, you agree to our Terms and Privacy Policy
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  header: {
    alignItems: 'center',
    paddingTop: 30,
    paddingBottom: 12,
  },
  emoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
  pickerContainer: {
    height: height * 0.45,
    position: 'relative',
  },
  fadeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 80,
    backgroundColor: 'rgba(10,10,10,0.95)',
    zIndex: 1,
  },
  fadeBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 40,
    backgroundColor: 'rgba(10,10,10,0.95)',
    zIndex: 1,
  },
  centerLine: {
    position: 'absolute',
    top: '50%',
    left: '10%',
    right: '10%',
    height: 1,
    backgroundColor: 'rgba(183,110,121,0.5)',
    transform: [{ translateY: -20 }],
    zIndex: 3,
    borderRadius: 1,
  },
  centerLineBottom: {
    position: 'absolute',
    top: '50%',
    left: '10%',
    right: '10%',
    height: 1,
    backgroundColor: 'rgba(183,110,121,0.5)',
    transform: [{ translateY: 62 }],
    zIndex: 3,
    borderRadius: 1,
  },
  ageItem: {
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  ageText: {
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  ageTextSelected: {
    fontSize: 38,
    fontWeight: '800',
    color: '#ffffff',
  },
  ageTextNear: {
    fontSize: 26,
    color: '#aaaaaa',
  },
  ageTextFar: {
    fontSize: 14,
    color: '#333333',
  },
  indicator: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#B76E79',
    right: '25%',
    top: '50%',
    marginTop: -4,
  },
  selectedDisplay: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  selectedLabel: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  selectedValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#B76E79',
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    paddingTop: 20,
  },
  button: {
    backgroundColor: '#ffffff',
    paddingVertical: 18,
    borderRadius: 30,
    alignItems: 'center',
    marginBottom: 16,
  },
  buttonText: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '700',
  },
  terms: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center',
    lineHeight: 18,
  },
});
