#!/bin/sh
# Downloads the word-list sources into tools/sources/ (not committed).
# Only needed to rebuild js/words.js:  sh tools/fetch-sources.sh && node tools/build-words.js
set -e
cd "$(dirname "$0")"
mkdir -p sources && cd sources

# ENABLE2K word list (public domain)
curl -sL -o enable1.txt https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt

# SCOWL 2020.12.07 by Kevin Atkinson (MIT-style license, see README). Its size tiers
# (10 = most common ... 95 = rarest) tell us how everyday a word is.
curl -sL -o scowl.tar.gz https://downloads.sourceforge.net/project/wordlist/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz
rm -rf scowl && mkdir scowl && tar xzf scowl.tar.gz -C scowl --strip-components=1

# Word frequencies from OpenSubtitles (hermitdave/FrequencyWords, CC BY-SA 4.0).
# Used only as a build-time signal for picking common words; none of it ships.
curl -sL -o en_50k.txt https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt

# List of Dirty, Naughty, Obscene and Otherwise Bad Words (CC BY 4.0)
curl -sL -o ldnoobw.txt https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en

echo "Sources ready in tools/sources/"
