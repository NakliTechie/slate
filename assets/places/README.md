# Places data

Built by `node scripts/build-places.mjs` on 2026-11-16. Slate fetches these files from its own
origin the first time you open Places; nothing else is requested.

| File | Contents | Source | Licence |
|---|---|---|---|
| `cities.bin` | 64693 places with population 5,000 or more, without city sections (PPLX) or historical places: name, country code, latitude and longitude (format in the script header) | GeoNames `cities5000.zip`, https://download.geonames.org/export/dump/cities5000.zip | CC BY 4.0, https://creativecommons.org/licenses/by/4.0/ |
| `countries.json` `names` | Country names by ISO code | GeoNames `countryInfo.txt`, https://download.geonames.org/export/dump/countryInfo.txt | CC BY 4.0 |
| `countries.json` `countries` | 177 country outlines at 1:110m, rounded to 0.01 degree | Natural Earth, https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_admin_0_countries.geojson | Public domain, https://www.naturalearthdata.com/about/terms-of-use/ |

Attribution: place names from GeoNames (geonames.org), licensed CC BY 4.0. Country outlines
from Natural Earth (naturalearthdata.com), public domain. Slate changed the GeoNames data by
keeping only these four fields and rounding coordinates to 0.00001 degree.
