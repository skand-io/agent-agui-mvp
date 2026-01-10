"""
Get Weather Tool

Backend tool that fetches real weather data using the Open-Meteo API (free, no key required).
"""

import httpx

from tracing import tracer


async def get_weather(city: str) -> str:
    """Backend tool - get real weather for a city using Open-Meteo API (free, no key required)."""
    tracer.log_event("GET_WEATHER", f"fetching weather for city={city}")

    async with httpx.AsyncClient() as client:
        # Step 1: Geocode the city name to get coordinates
        geocode_url = "https://geocoding-api.open-meteo.com/v1/search"
        geocode_response = await client.get(geocode_url, params={"name": city, "count": 1})
        geocode_data = geocode_response.json()

        if not geocode_data.get("results"):
            return f"Could not find city: {city}"

        location = geocode_data["results"][0]
        lat, lon = location["latitude"], location["longitude"]
        city_name = location.get("name", city)
        country = location.get("country", "")

        # Step 2: Get current weather using coordinates
        weather_url = "https://api.open-meteo.com/v1/forecast"
        weather_response = await client.get(weather_url, params={
            "latitude": lat,
            "longitude": lon,
            "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
            "temperature_unit": "celsius",
        })
        weather_data = weather_response.json()

        current = weather_data.get("current", {})
        temp = current.get("temperature_2m", "N/A")
        humidity = current.get("relative_humidity_2m", "N/A")
        wind_speed = current.get("wind_speed_10m", "N/A")
        weather_code = current.get("weather_code", 0)

        # Map weather codes to descriptions
        weather_descriptions = {
            0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
            45: "Foggy", 48: "Depositing rime fog",
            51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
            61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
            71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
            80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
            95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
        }
        condition = weather_descriptions.get(weather_code, "Unknown")

        result = f"Weather in {city_name}, {country}: {temp}°C, {condition}. Humidity: {humidity}%, Wind: {wind_speed} km/h"
        tracer.log_event("GET_WEATHER_RESULT", f"result={result}")
        return result
