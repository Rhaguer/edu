#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

#if defined(_WIN32)
#define EA_EXPORT extern "C" __declspec(dllexport)
#else
#define EA_EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace {

constexpr const char* kVersion = "eduandes-native-cpp20/1.0.0";

// Decode one UTF-8 sequence at pos; advances pos; returns U+FFFD on malformed bytes.
uint32_t decode_utf8(std::string_view s, size_t& pos) {
    const unsigned char b0 = static_cast<unsigned char>(s[pos]);
    if (b0 < 0x80) {
        ++pos;
        return b0;
    }
    if ((b0 & 0xE0) == 0xC0 && pos + 1 < s.size()) {
        const unsigned char b1 = static_cast<unsigned char>(s[pos + 1]);
        if ((b1 & 0xC0) == 0x80) {
            const uint32_t cp = ((b0 & 0x1Fu) << 6) | (b1 & 0x3Fu);
            if (cp >= 0x80) {
                pos += 2;
                return cp;
            }
        }
    } else if ((b0 & 0xF0) == 0xE0 && pos + 2 < s.size()) {
        const unsigned char b1 = static_cast<unsigned char>(s[pos + 1]);
        const unsigned char b2 = static_cast<unsigned char>(s[pos + 2]);
        if ((b1 & 0xC0) == 0x80 && (b2 & 0xC0) == 0x80) {
            const uint32_t cp = ((b0 & 0x0Fu) << 12) | ((b1 & 0x3Fu) << 6) | (b2 & 0x3Fu);
            if (cp >= 0x800 && !(cp >= 0xD800 && cp <= 0xDFFF)) {
                pos += 3;
                return cp;
            }
        }
    } else if ((b0 & 0xF8) == 0xF0 && pos + 3 < s.size()) {
        const unsigned char b1 = static_cast<unsigned char>(s[pos + 1]);
        const unsigned char b2 = static_cast<unsigned char>(s[pos + 2]);
        const unsigned char b3 = static_cast<unsigned char>(s[pos + 3]);
        if ((b1 & 0xC0) == 0x80 && (b2 & 0xC0) == 0x80 && (b3 & 0xC0) == 0x80) {
            const uint32_t cp =
                ((b0 & 0x07u) << 18) | ((b1 & 0x3Fu) << 12) | ((b2 & 0x3Fu) << 6) | (b3 & 0x3Fu);
            if (cp >= 0x10000 && cp <= 0x10FFFF) {
                pos += 4;
                return cp;
            }
        }
    }
    ++pos;
    return 0xFFFDu;
}

void append_utf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
        out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
        out.push_back(static_cast<char>(0xC0u | (cp >> 6)));
        out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
    } else if (cp < 0x10000) {
        out.push_back(static_cast<char>(0xE0u | (cp >> 12)));
        out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
        out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
    } else {
        out.push_back(static_cast<char>(0xF0u | (cp >> 18)));
        out.push_back(static_cast<char>(0x80u | ((cp >> 12) & 0x3Fu)));
        out.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
        out.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
    }
}

bool is_combining_mark(uint32_t cp) {
    return (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x1AB0 && cp <= 0x1AFF) ||
           (cp >= 0x1DC0 && cp <= 0x1DFF) || (cp >= 0x20D0 && cp <= 0x20FF) ||
           (cp >= 0xFE20 && cp <= 0xFE2F);
}

// Fold common Latin diacritics and ASCII uppercase; returns 0 if punctuation/whitespace.
uint32_t fold_codepoint(uint32_t cp) {
    if (cp < 0x80) {
        if (cp >= 'A' && cp <= 'Z') return cp + 32;
        if ((cp >= 'a' && cp <= 'z') || (cp >= '0' && cp <= '9') || cp == '_') return cp;
        return 0;
    }
    switch (cp) {
        case 0x00C0: case 0x00C1: case 0x00C2: case 0x00C3: case 0x00C4: case 0x00C5:
        case 0x00E0: case 0x00E1: case 0x00E2: case 0x00E3: case 0x00E4: case 0x00E5:
        case 0x0100: case 0x0101: case 0x0102: case 0x0103: case 0x0104: case 0x0105:
            return 'a';
        case 0x00C7: case 0x00E7: case 0x0106: case 0x0107: case 0x010C: case 0x010D:
            return 'c';
        case 0x010E: case 0x010F: case 0x0110: case 0x0111:
            return 'd';
        case 0x00C8: case 0x00C9: case 0x00CA: case 0x00CB:
        case 0x00E8: case 0x00E9: case 0x00EA: case 0x00EB:
        case 0x0112: case 0x0113: case 0x0114: case 0x0115: case 0x0118: case 0x0119:
            return 'e';
        case 0x00CC: case 0x00CD: case 0x00CE: case 0x00CF:
        case 0x00EC: case 0x00ED: case 0x00EE: case 0x00EF:
        case 0x012A: case 0x012B:
            return 'i';
        case 0x00D1: case 0x00F1: case 0x0143: case 0x0144: case 0x0147: case 0x0148:
            return 'n';
        case 0x00D2: case 0x00D3: case 0x00D4: case 0x00D5: case 0x00D6: case 0x00D8:
        case 0x00F2: case 0x00F3: case 0x00F4: case 0x00F5: case 0x00F6: case 0x00F8:
        case 0x014C: case 0x014D:
            return 'o';
        case 0x0158: case 0x0159:
            return 'r';
        case 0x015A: case 0x015B: case 0x0160: case 0x0161:
            return 's';
        case 0x00D9: case 0x00DA: case 0x00DB: case 0x00DC:
        case 0x00F9: case 0x00FA: case 0x00FB: case 0x00FC:
        case 0x016A: case 0x016B:
            return 'u';
        case 0x00DD: case 0x00FD: case 0x00FF: case 0x0178:
            return 'y';
        case 0x0179: case 0x017A: case 0x017D: case 0x017E:
            return 'z';
        // Common non-alphanumeric punctuation / whitespace symbols -> separator
        case 0x00A0: case 0x00A1: case 0x00AB: case 0x00B7: case 0x00BB: case 0x00BF:
        case 0x00D7: case 0x00F7: case 0x200B: case 0x200C: case 0x200D: case 0xFEFF:
        case 0x2010: case 0x2011: case 0x2012: case 0x2013: case 0x2014: case 0x2015:
        case 0x2018: case 0x2019: case 0x201C: case 0x201D: case 0x2022: case 0x2026:
        case 0xFFFD:
            return 0;
        default:
            if (cp >= 0x2000 && cp <= 0x206F) return 0;  // General punctuation
            if (cp >= 0x2190 && cp <= 0x2BFF) return 0;  // Arrows / math / box / symbols
            return cp;
    }
}

struct NormalizedText {
    std::string text;
    std::vector<size_t> orig_cp_index;
};

NormalizedText normalize_with_map(std::string_view input) {
    NormalizedText result;
    result.text.reserve(input.size());
    result.orig_cp_index.reserve(input.size());

    bool prev_space = true;
    size_t byte_pos = 0;
    size_t cp_index = 0;
    while (byte_pos < input.size()) {
        const uint32_t cp = decode_utf8(input, byte_pos);
        if (is_combining_mark(cp)) {
            ++cp_index;
            continue;
        }
        const uint32_t folded = fold_codepoint(cp);
        if (folded != 0) {
            const size_t before = result.text.size();
            append_utf8(result.text, folded);
            for (size_t k = before; k < result.text.size(); ++k) {
                result.orig_cp_index.push_back(cp_index);
            }
            prev_space = false;
        } else if (!prev_space) {
            result.text.push_back(' ');
            result.orig_cp_index.push_back(cp_index);
            prev_space = true;
        }
        ++cp_index;
    }
    while (!result.text.empty() && result.text.back() == ' ') {
        result.text.pop_back();
        result.orig_cp_index.pop_back();
    }
    return result;
}

bool is_word_byte(unsigned char c) {
    return std::isalnum(c) != 0 || c == '_' || c >= 0x80;
}

bool find_word_bounded(const NormalizedText& norm_src, std::string_view needle_norm,
                       size_t& out_start_cp, size_t& out_end_cp) {
    if (needle_norm.size() < 3 || needle_norm.size() > norm_src.text.size()) {
        return false;
    }
    size_t pos = 0;
    while ((pos = norm_src.text.find(needle_norm, pos)) != std::string::npos) {
        const size_t end = pos + needle_norm.size();
        const bool left_ok = (pos == 0) || !is_word_byte(static_cast<unsigned char>(norm_src.text[pos - 1]));
        const bool right_ok = (end == norm_src.text.size()) || !is_word_byte(static_cast<unsigned char>(norm_src.text[end]));
        if (left_ok && right_ok) {
            out_start_cp = norm_src.orig_cp_index[pos];
            out_end_cp = norm_src.orig_cp_index[end - 1] + 1;
            return true;
        }
        ++pos;
    }
    return false;
}

bool contains_ci(std::string_view haystack, std::string_view needle) {
    if (needle.empty() || haystack.size() < needle.size()) return false;
    auto it = std::search(
        haystack.begin(), haystack.end(), needle.begin(), needle.end(),
        [](unsigned char a, unsigned char b) {
            return std::tolower(a) == std::tolower(b);
        });
    return it != haystack.end();
}

uint64_t fnv1a_step(uint64_t h, std::string_view word) {
    for (unsigned char c : word) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    h ^= 0xFFu;
    h *= 1099511628211ULL;
    return h;
}

std::vector<std::string_view> split_spaces(std::string_view s) {
    std::vector<std::string_view> words;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && s[i] == ' ') ++i;
        if (i >= s.size()) break;
        size_t j = i;
        while (j < s.size() && s[j] != ' ') ++j;
        words.push_back(s.substr(i, j - i));
        i = j;
    }
    return words;
}

char* alloc_cstr(std::string_view s) {
    char* ptr = static_cast<char*>(std::malloc(s.size() + 1));
    if (!ptr) return nullptr;
    if (!s.empty()) std::memcpy(ptr, s.data(), s.size());
    ptr[s.size()] = '\0';
    return ptr;
}

}  // namespace

// Constant-time byte comparison for HMAC signatures and session tokens.
EA_EXPORT int ea_ct_equal(const char* a, size_t a_len, const char* b, size_t b_len) {
    if ((!a && a_len > 0) || (!b && b_len > 0)) return -1;
    if (a_len != b_len) return 0;
    volatile unsigned char diff = 0;
    for (size_t i = 0; i < a_len; ++i) {
        diff |= static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i]);
    }
    return diff == 0 ? 1 : 0;
}

EA_EXPORT const char* ea_version() {
    return kVersion;
}

EA_EXPORT void ea_free(char* ptr) {
    std::free(ptr);
}

// Returns 1 if safe, 0 if any reserved chat marker or NUL byte is present, -1 on invalid args.
EA_EXPORT int ea_scan_safety(const char* data, size_t len) {
    if (!data && len > 0) return -1;
    if (len == 0) return 1;
    const std::string_view view(data, len);
    if (view.find('\0') != std::string_view::npos) return 0;
    static constexpr const char* kMarkers[] = {
        "<|im_start|>", "<|im_end|>", "<|endoftext|>", "<think>", "</think>"
    };
    for (const char* marker : kMarkers) {
        if (view.find(marker) != std::string_view::npos) return 0;
    }
    return 1;
}

// Returns 1 if XML buffer is safe against DOCTYPE/ENTITY injection and size <= 10 MiB.
EA_EXPORT int ea_check_xml_safety(const char* data, size_t len) {
    if (!data && len > 0) return -1;
    constexpr size_t kMaxXmlBytes = 10u * 1024u * 1024u;
    if (len > kMaxXmlBytes) return 0;
    const std::string_view view(data, len);
    if (view.find('\0') != std::string_view::npos) return 0;
    if (contains_ci(view, "<!doctype") || contains_ci(view, "<!entity")) return 0;
    return 1;
}

// Returns 1 if zip entry path is safe (relative, no traversal, no vbaproject), 0 otherwise.
EA_EXPORT int ea_is_safe_zip_entry(const char* path, size_t len) {
    if (!path || len == 0 || len > 4096) return 0;
    const std::string_view raw(path, len);
    if (raw.find('\0') != std::string_view::npos) return 0;
    if (raw[0] == '/' || raw[0] == '\\') return 0;
    if (raw.size() >= 2 && std::isalpha(static_cast<unsigned char>(raw[0])) && raw[1] == ':') return 0;
    if (contains_ci(raw, "vbaproject")) return 0;

    size_t i = 0;
    while (i < raw.size()) {
        size_t j = i;
        while (j < raw.size() && raw[j] != '/' && raw[j] != '\\') ++j;
        const std::string_view part = raw.substr(i, j - i);
        if (part == "..") return 0;
        i = j + 1;
    }
    return 1;
}

EA_EXPORT char* ea_normalize_utf8(const char* data, size_t len) {
    if (!data && len > 0) return nullptr;
    if (!data || len == 0) return alloc_cstr("");
    const NormalizedText norm = normalize_with_map(std::string_view(data, len));
    return alloc_cstr(norm.text);
}

// Finds needle inside source using normalized Spanish folding and word boundaries.
// Strips common Spanish articles ("el ", "la ", "los ", "las ", "un ", "una ", "unos ", "unas ") as fallback.
// Returns 1 if found (populating out_start_cp, out_end_cp as Python str codepoint indices), 0 if not found, -1 on error.
EA_EXPORT int ea_find_literal_span(const char* source, size_t src_len,
                                   const char* needle, size_t ndl_len,
                                   size_t* out_start_cp, size_t* out_end_cp) {
    if (!out_start_cp || !out_end_cp) return -1;
    if ((!source && src_len > 0) || (!needle && ndl_len > 0)) return -1;
    if (src_len == 0 || ndl_len == 0) return 0;

    const NormalizedText norm_src = normalize_with_map(std::string_view(source, src_len));
    const NormalizedText norm_ndl = normalize_with_map(std::string_view(needle, ndl_len));
    if (find_word_bounded(norm_src, norm_ndl.text, *out_start_cp, *out_end_cp)) {
        return 1;
    }

    static constexpr std::string_view kArticles[] = {
        "el ", "la ", "los ", "las ", "un ", "una ", "unos ", "unas "
    };
    const std::string_view ndl_view(norm_ndl.text);
    for (std::string_view art : kArticles) {
        if (ndl_view.size() > art.size() && ndl_view.compare(0, art.size(), art) == 0) {
            if (find_word_bounded(norm_src, ndl_view.substr(art.size()), *out_start_cp, *out_end_cp)) {
                return 1;
            }
            break;
        }
    }
    return 0;
}

// Returns 1 if left and right are distinct (not identical and no shared 8-word sequence), 0 otherwise.
EA_EXPORT int ea_is_distinct_8gram(const char* left, size_t left_len,
                                    const char* right, size_t right_len) {
    if ((!left && left_len > 0) || (!right && right_len > 0)) return -1;
    const NormalizedText nl = normalize_with_map(left ? std::string_view(left, left_len) : std::string_view{});
    const NormalizedText nr = normalize_with_map(right ? std::string_view(right, right_len) : std::string_view{});
    const auto wa = split_spaces(nl.text);
    const auto wb = split_spaces(nr.text);
    if (wa == wb) return 0;
    if (wa.size() < 8 || wb.size() < 8) return 1;

    std::unordered_set<uint64_t> hashes;
    hashes.reserve(wa.size());
    for (size_t i = 0; i + 8 <= wa.size(); ++i) {
        uint64_t h = 14695981039346656037ULL;
        for (size_t k = 0; k < 8; ++k) h = fnv1a_step(h, wa[i + k]);
        hashes.insert(h);
    }
    for (size_t i = 0; i + 8 <= wb.size(); ++i) {
        uint64_t h = 14695981039346656037ULL;
        for (size_t k = 0; k < 8; ++k) h = fnv1a_step(h, wb[i + k]);
        if (hashes.find(h) != hashes.end()) {
            // Confirm exact slice on hash hit to avoid any theoretical collision.
            for (size_t a_idx = 0; a_idx + 8 <= wa.size(); ++a_idx) {
                if (std::equal(wa.begin() + static_cast<std::ptrdiff_t>(a_idx),
                               wa.begin() + static_cast<std::ptrdiff_t>(a_idx + 8),
                               wb.begin() + static_cast<std::ptrdiff_t>(i))) {
                    return 0;
                }
            }
        }
    }
    return 1;
}
