# Rooikat Watch

A data explorer for caracal (rooikat) sightings on the Cape Peninsula, South Africa. The sightings are reported by the public to the [Urban Caracal Project](https://www.urbancaracal.org/report-sightings-roadkill), which studies how caracals survive in and around Cape Town.

It maps every report, follows individual ear-tagged cats over time, and charts when and how people see them. There is a desktop page and a lighter mobile page. Phones are sent to the mobile page automatically.

**Live:** https://lone-wolfgang.github.io/caracal/

## Refreshing with new data

1. **Get a new export.** Save the spreadsheet as `sightings.xlsx` in the project root.
   It contains reporters' names and emails, so it is gitignored. Never commit it.

2. **Install the dependencies** (first time only):
   ```
   pip install pandas openpyxl geopandas shapely
   ```

3. **Clean the data.** This writes `data/sightings.json` and `data/quality_report.json`, with names and emails removed:
   ```
   python3 build/clean_sightings.py
   ```
   It stops with `FATAL` if any contact details would leak into the output.

4. **Build the pages.** This writes `caracal.html` and `caracal-mobile.html`:
   ```
   python3 build/bundle.py
   ```
   To preview, open `caracal.html` in a browser.

5. **Publish:**
   ```
   git add data/ caracal.html caracal-mobile.html
   git commit -m "Refresh sightings data"
   git push
   ```
   Pushing to `master` deploys the site through GitHub Actions within a minute or two.

**Worth a check after a refresh**
- The "Data notes" text quotes counts from the current export, such as how many rows have coordinates. It lives in `notesHTML` in `src/core.js`. Compare it with `data/quality_report.json`.
- `LOCATION_FIXES` in `build/clean_sightings.py` corrects one row by its row number. If the new export reorders rows, check that it still points at the right sighting.
