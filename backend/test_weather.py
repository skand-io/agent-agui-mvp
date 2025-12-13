"""
Unit tests for the weather API integration.

Run with: uv run python test_weather.py
"""
import sys

# Import the weather function directly
from server import get_weather


def test_valid_city():
    """Test weather for a valid city"""
    print("\n" + "=" * 60)
    print("TEST: Valid city (Tokyo)")
    print("=" * 60)

    result = get_weather("Tokyo")
    print(f"Result:\n{result}")

    assert "Tokyo" in result, "Expected 'Tokyo' in result"
    assert "Japan" in result, "Expected 'Japan' in result"
    assert "Temperature:" in result, "Expected temperature in result"
    assert "°C" in result, "Expected temperature unit in result"
    assert "Humidity:" in result, "Expected humidity in result"
    assert "Wind:" in result, "Expected wind in result"

    print("\n✅ Valid city test PASSED!")
    return True


def test_city_with_spaces():
    """Test weather for a city with spaces in the name"""
    print("\n" + "=" * 60)
    print("TEST: City with spaces (New York)")
    print("=" * 60)

    result = get_weather("New York")
    print(f"Result:\n{result}")

    assert "New York" in result, "Expected 'New York' in result"
    assert "United States" in result, "Expected 'United States' in result"
    assert "Temperature:" in result, "Expected temperature in result"

    print("\n✅ City with spaces test PASSED!")
    return True


def test_invalid_city():
    """Test weather for an invalid/nonexistent city"""
    print("\n" + "=" * 60)
    print("TEST: Invalid city")
    print("=" * 60)

    result = get_weather("xyznonexistentcity12345")
    print(f"Result:\n{result}")

    assert "Could not find location" in result, "Expected 'Could not find location' error"

    print("\n✅ Invalid city test PASSED!")
    return True


def test_international_cities():
    """Test weather for various international cities"""
    print("\n" + "=" * 60)
    print("TEST: International cities")
    print("=" * 60)

    cities = [
        ("London", "United Kingdom"),
        ("Paris", "France"),
        ("Sydney", "Australia"),
    ]

    for city, expected_country in cities:
        result = get_weather(city)
        print(f"\n{city}:\n{result}")

        assert city in result, f"Expected '{city}' in result"
        assert expected_country in result, f"Expected '{expected_country}' in result"
        assert "Temperature:" in result, f"Expected temperature for {city}"

    print("\n✅ International cities test PASSED!")
    return True


def test_weather_data_format():
    """Test that weather data has expected format"""
    print("\n" + "=" * 60)
    print("TEST: Weather data format")
    print("=" * 60)

    result = get_weather("Berlin")
    print(f"Result:\n{result}")

    # Check all expected fields are present
    expected_fields = ["Condition:", "Temperature:", "feels like", "Humidity:", "Wind:"]
    for field in expected_fields:
        assert field in result, f"Expected '{field}' in result"

    # Check units are present
    assert "°C" in result, "Expected Celsius unit"
    assert "%" in result, "Expected percentage for humidity"
    assert "km/h" in result, "Expected km/h for wind speed"

    print("\n✅ Weather data format test PASSED!")
    return True


def run_all_tests():
    """Run all weather tests"""
    print("\n" + "=" * 60)
    print("WEATHER API UNIT TESTS")
    print("=" * 60)

    tests = [
        ("valid_city", test_valid_city),
        ("city_with_spaces", test_city_with_spaces),
        ("invalid_city", test_invalid_city),
        ("international_cities", test_international_cities),
        ("weather_data_format", test_weather_data_format),
    ]

    results = {}
    for name, test_fn in tests:
        try:
            results[name] = test_fn()
        except AssertionError as e:
            print(f"\n❌ {name} test FAILED: {e}")
            results[name] = False
        except Exception as e:
            print(f"\n❌ {name} test ERROR: {e}")
            results[name] = False

    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)

    passed = sum(1 for v in results.values() if v)
    total = len(results)

    for test_name, passed_test in results.items():
        status = "✅ PASSED" if passed_test else "❌ FAILED"
        print(f"  {test_name}: {status}")

    print(f"\n{passed}/{total} tests passed")
    return all(results.values())


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
