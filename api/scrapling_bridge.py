import sys
import json
import argparse
from typing import List, Dict, Any, Optional
from scrapling import Fetcher
import re
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

class IkiruScraper:
    def __init__(self, base_url: str, username: Optional[str] = None, password: Optional[str] = None, cookies: Optional[Dict] = None):
        match = re.match(r'(https?://[^/]+)', base_url)
        self.base_url = match.group(1).rstrip('/') + '/' if match else base_url.rstrip('/') + '/'
        self.fetcher = Fetcher()
        self.username = username
        self.password = password
        self.cookies = cookies or {}
        self._is_logged_in = bool(cookies)

    def _do_get(self, url, **kwargs):
        res = self.fetcher.get(url, cookies=self.cookies, **kwargs)
        if hasattr(res, 'cookies') and res.cookies:
            self.cookies.update(res.cookies)
        return res

    def _do_post(self, url, data=None, **kwargs):
        res = self.fetcher.post(url, data=data, cookies=self.cookies, **kwargs)
        if hasattr(res, 'cookies') and res.cookies:
            self.cookies.update(res.cookies)
        return res

    def to_absolute_url(self, url: str) -> str:
        if not url: return ""
        url = url.strip()
        if url.startswith('//'): return f"https:{url}"
        if url.startswith('/'): return f"{self.base_url.rstrip('/')}{url}"
        if url.startswith('http'): return url
        return f"{self.base_url}{url}"

    def normalize_text(self, text: Any) -> str:
        if not text: return ""
        if hasattr(text, 'get_all_text'):
            val = text.get_all_text()
        elif hasattr(text, 'getall'):
            val = " ".join(text.getall())
        elif hasattr(text, 'get'):
            val = str(text.get() or "")
        else:
            val = str(text)
        
        val = re.sub(r'<[^>]+>', '', val)
        
        # Robust De-spacing logic for obfuscated text (e.g. "B e c o m i n g")
        if len(val) > 3:
            spaces = val.count(' ')
            if spaces > len(val) / 3:
                # Heuristic: treat 2 or more spaces as a word boundary, single space as letter boundary
                # First, protect potential word boundaries (2+ spaces)
                val = re.sub(r'\s{2,}', '\0', val)
                # Remove single spaces (letter boundaries)
                val = val.replace(' ', '')
                # Restore word boundaries as single spaces
                val = val.replace('\0', ' ')

        return " ".join(val.split()).strip()

    def normalize_status(self, status: Any) -> str:
        s = self.normalize_text(status).lower()
        if any(x in s for x in ["ongoing", "berjalan", "on-going", "publishing", "active", "rutin"]): return "Ongoing"
        if any(x in s for x in ["completed", "selesai", "tamat", "finish", "end", "tuntas"]): return "Completed"
        if any(x in s for x in ["hiatus", "drop", "pending", "break", "istirahat"]): return "Hiatus"
        return "Ongoing"  # Default for Ikiru to avoid "Unknown" in UI

    def login_if_needed(self):
        if self._is_logged_in or not self.username or not self.password:
            return
        try:
            res = self._do_get(f"{self.base_url}auth/")
            if res.status != 200: return
            nonce_match = re.search(r'nonce=([a-zA-Z0-9]+)', res.text)
            if not nonce_match: return
            nonce = nonce_match.group(1)
            ajax_url = f"{self.base_url}wp-admin/admin-ajax.php?nonce={nonce}&action=login_user"
            post_res = self._do_post(ajax_url, data={"email": self.username, "password": self.password})
            if post_res.status == 200:
                self._is_logged_in = True
        except Exception as e:
            sys.stderr.write(f"Login Error: {str(e)}\n")

    def fetch_manga_details(self, manga_url: str, skip_meta: bool = False) -> Dict[str, Any]:
        """
        Fetches both chapters and metadata for a manga.
        Returns: {"chapters": [], "metadata": {}}
        """
        try:
            self.login_if_needed()
            response = self._do_get(manga_url)
            if response.status != 200: return {"chapters": [], "metadata": {}}
            page = response
            
            title = self.normalize_text(
                page.css("h1::text").get() 
                or page.css("[itemprop='name']::text").get()
                or page.css(".manga-title::text").get()
                or page.css("h1.entry-title::text").get()
                or page.css("div.post-title h1::text").get()
            )
            
            manga_id_match = re.search(r'manga_id=(\d+)', response.text or "")
            manga_id = manga_id_match.group(1) if manga_id_match else None
            
            meta = {}
            if not skip_meta:
                # Rating
                rating_raw = (
                    page.css("div.numscore::text").get()
                    or page.xpath("//li[descendant::small[contains(., 'Ratings')]]//span[contains(@class, 'font-bold')]/text()").get()
                    or page.css(".font-bold.text-2xl::text").get()
                    or page.css("div.rating-value::text").get()
                )
                
                rating = self.normalize_text(rating_raw)
                
                # Validation: Rating must be numeric (e.g. 8.5, 9) and NOT the title
                is_numeric = bool(re.search(r'\d', rating))
                if rating and is_numeric and rating.lower() != title.lower():
                    # Extract only the numeric part (handle cases like "8.5 / 10")
                    num_match = re.search(r'(\d+(?:\.\d+)?)', rating)
                    rating = num_match.group(1) if num_match else "N/A"
                else:
                    rating = "N/A"
                
                # Status - Robust detection
                status_raw = None
                # Try finding status label and its value
                status_el = page.xpath("//*[contains(text(), 'Status') or contains(text(), 'status')]/following-sibling::*//text()").get()
                if status_el:
                    status_raw = status_el
                
                if not status_raw:
                    # Look for badges by color or text
                    badges = page.css("span.bg-green-600, span.bg-green-500, span.bg-yellow-500, span.bg-red-500, .bg-green-500, .bg-yellow-500, .bg-red-500")
                    for b in badges:
                        txt = self.normalize_text(b)
                        if any(x in txt.lower() for x in ["ongoing", "berjalan", "completed", "selesai", "tamat", "hiatus", "drop"]):
                            status_raw = txt
                            break
                
                if not status_raw:
                    # Check text content of common status containers
                    info_els = page.css("div.flex.flex-col span, div.flex.flex-col div, .post-content_item")
                    for el in info_els:
                        ltxt = self.normalize_text(el).lower()
                        if "ongoing" in ltxt or "berjalan" in ltxt: status_raw = "Ongoing"; break
                        if "completed" in ltxt or "tamat" in ltxt: status_raw = "Completed"; break
                        if "hiatus" in ltxt: status_raw = "Hiatus"; break
                
                # Genres
                genres = [self.normalize_text(g) for g in page.css('a[href*="/genre/"], a[href*="/manga-genre/"], .manga-genres a, .genres-content a')]
                if not genres:
                    # Alternative approach for some layouts
                    genres = [self.normalize_text(g) for g in page.css("span.bg-secondary\\/30 a, div.bg-secondary\\/30 a")]
                
                # Description - Robust selectors
                # The site uses various classes for description, often in a synopsis tab
                description_selectors = [
                    "div.bg-primary-bg.shadow-inner.p-4.text-sm", 
                    "div.mb-4.text-sm.leading-relaxed.text-gray-400", 
                    "div.mb-4.text-sm.leading-relaxed",
                    "div.entry-content p",
                    "div.summary-content p",
                    "div.post-content_item p",
                    "div.description-summary p",
                    "div.manga-summary p",
                    "[itemprop='description'][data-show='true']",
                    "[itemprop='description']",
                    "div.p-4.rounded-xl.bg-background-200\\/50 p",
                    "div.p-4.rounded-xl.bg-background-200\\/50",
                    "div.summary-content",
                    "div#summary",
                    "div.post-content_item",
                    "meta[property='og:description']::attr(content)",
                    "meta[name='description']::attr(content)"
                ]
                
                description = ""
                for sel in description_selectors:
                    els = page.css(sel)
                    if not els: continue
                    
                    # Join all text from all matching elements (e.g. all <p> tags)
                    if hasattr(els, 'getall'):
                        val = self.normalize_text(" ".join(els.getall()))
                    else:
                        val = self.normalize_text(els)
                        
                    if val and len(val) > 15: # Avoid short noise
                        description = val
                        break
                
                cover = (
                    page.xpath("//img[contains(@class, 'wp-post-image')]/@src").get() 
                    or page.css("img.wp-post-image::attr(src)").get()
                    or page.css("img[itemprop='image']::attr(src)").get()
                )
                
                meta = {
                    "title": title,
                    "cover": self.to_absolute_url(cover or ""), 
                    "rating": self.normalize_text(rating) or "N/A", 
                    "status": self.normalize_status(status_raw) if status_raw else "Ongoing", 
                    "description": description,
                    "genres": genres
                }
            
            chapters = []
            if manga_id:
                ajax_res = self._do_get(f"{self.base_url}wp-admin/admin-ajax.php?manga_id={manga_id}&action=chapter_list")
                if ajax_res.status == 200:
                    for link in ajax_res.css("a[href*='/chapter-']"):
                        c_url = self.to_absolute_url(str(link.attrib.get("href") or ""))
                        c_text_raw = link.get_all_text()
                        c_text_match = re.search(r'Chapter\s+\d+(\.\d+)?', c_text_raw, re.IGNORECASE)
                        c_text = c_text_match.group(0) if c_text_match else self.normalize_text(c_text_raw).split(' ')[0]
                        if c_url and c_text:
                            chapters.append({"title": title, "chapter": c_text, "url": c_url, "updatedTime": "", "mangaUrl": manga_url, "source": "ikiru", **meta})
            
            if not chapters:
                for link in page.xpath("//a[contains(@href, '/chapter-')]"):
                    c_url = self.to_absolute_url(str(link.attrib.get("href") or ""))
                    c_text = self.normalize_text(link)
                    if c_url and c_text:
                        chapters.append({"title": title, "chapter": c_text, "url": c_url, "updatedTime": "", "mangaUrl": manga_url, "source": "ikiru", **meta})
            
            return {"chapters": chapters, "metadata": meta}
        except Exception as e:
            sys.stderr.write(f"Scraper Error: {str(e)}\n")
            return {"chapters": [], "metadata": {}}

    def fetch_manga_page(self, manga_url: str, skip_meta: bool = False) -> List[Dict[str, Any]]:
        details = self.fetch_manga_details(manga_url, skip_meta)
        return details["chapters"]

    def fetch_latest(self, max_pages: int = 1) -> List[Dict[str, Any]]:
        results = []
        seen_keys = set()
        manga_meta_cache = {}
        
        for p in range(1, max_pages + 1):
            url = f"{self.base_url}latest-update/" if p == 1 else f"{self.base_url}latest-update/?the_page={p}"
            try:
                self.login_if_needed()
                response = self._do_get(url)
                if response.status != 200: break
                manga_links = response.xpath("//a[contains(@href, '/manga/')]")
                for link in manga_links:
                    manga_url = self.to_absolute_url(link.attrib.get('href', ''))
                    if not manga_url or '/chapter-' in manga_url: continue
                    
                    title = self.normalize_text(link)
                    if not title:
                        title = self.normalize_text(link.css("img::attr(alt)").get())
                    
                    if not title: continue
                    
                    container = link.parent
                    found_chapters = False
                    for _ in range(3):
                        if container:
                            chaps_in_container = container.css("a.link-self, a[href*='/chapter-']")
                            if len(chaps_in_container) > 0:
                                found_chapters = True
                                break
                            container = container.parent
                    
                    if not found_chapters or not container: continue
                    
                    img = container.css("img::attr(src), img::attr(data-src)").get()
                    status_raw = container.xpath(".//*[contains(text(), 'Ongoing') or contains(text(), 'Completed') or contains(text(), 'Tamat') or contains(text(), 'Hiatus')]/text()").get()
                    if not status_raw:
                        if container.css("span.bg-green-600, span.bg-green-500, .bg-green-500").get():
                            status_raw = "Ongoing"
                        elif container.css("span.bg-yellow-500, span.bg-yellow-400, .bg-yellow-500").get():
                            status_raw = "Hiatus"
                        elif container.css("span.bg-red-500, span.bg-gray-500, .bg-red-500").get():
                            status_raw = "Completed"
                    
                    rating_raw = (
                        container.css("div.numscore::text").get()
                        or container.css(".numscore::text").get()
                        or container.css("span.font-bold::text").get()
                    )
                    
                    # Metadata (Status, Rating, Genres, Description)
                    # Optimization: Skip deep metadata fetch during latest updates scan.
                    # QStash workers will enrich missing metadata later if needed.
                    status = self.normalize_status(status_raw)
                    rating = self.normalize_text(rating_raw) or "N/A"
                    manga_data = {
                        "title": title, 
                        "mangaUrl": manga_url, 
                        "cover": self.to_absolute_url(str(img or "")), 
                        "status": status, 
                        "rating": rating, 
                        "genres": [],
                        "description": ""
                    }
                    
                    # Find chapters
                    for cl in container.css("a.link-self, a[href*='/chapter-']"):
                        c_text_raw = cl.get_all_text()
                        c_text_match = re.search(r'Chapter\s+\d+(\.\d+)?', c_text_raw, re.IGNORECASE)
                        c_text = c_text_match.group(0) if c_text_match else self.normalize_text(cl)
                        c_url = self.to_absolute_url(str(cl.attrib.get("href") or ""))
                        
                        c_time = ""
                        # Priority 1: Time inside the <a> tag (common in newer themes)
                        c_text_full = cl.get_all_text()
                        t_match = re.search(r'(\d+\s+(?:min|hour|day|week|month|ago|menit|jam|hari|detik)[^\n]*)', c_text_full, re.IGNORECASE)
                        if t_match:
                            c_time = t_match.group(1).strip()
                        else:
                            # Priority 2: Time in the parent container
                            p_text = cl.parent.get_all_text()
                            if p_text:
                                t_match = re.search(r'(\d+\s+(?:min|hour|day|week|month|ago|menit|jam|hari|detik)[^\n]*)', p_text, re.IGNORECASE)
                                if t_match:
                                    c_time = t_match.group(1).strip()
                        
                        if c_text and c_url and '/chapter-' in c_url:
                            key = f"{title}-{c_text}"
                            if key not in seen_keys:
                                seen_keys.add(key)
                                results.append({**manga_data, "chapter": c_text, "url": c_url, "updatedTime": c_time, "source": "ikiru"})
            except: break
        return results

    def search(self, query: str) -> List[Dict[str, Any]]:
        try:
            self.login_if_needed()
            response = self._do_get(f"{self.base_url}?s={query}")
            if response.status != 200: return []
            results = []
            # Try multiple selectors for search results
            manga_links = (
                response.css("a.text-base.font-medium") 
                or response.xpath("//a[contains(@class, 'text-base') and contains(@class, 'font-medium')]")
                or response.css("div.relative.group a[href*='/manga/']")
                or response.css("a[href*='/manga/']:not([href*='/chapter-'])")
            )
            
            # sys.stderr.write(f"DEBUG: Found {len(manga_links)} potential links\n")
            
            for link in manga_links:
                manga_url = self.to_absolute_url(str(link.attrib.get("href") or ""))
                if not manga_url or '/manga/' not in manga_url or '/chapter-' in manga_url: continue
                
                title = self.normalize_text(link)
                if not title:
                    title = self.normalize_text(link.css("img::attr(alt)").get())
                
                if not title: continue
                
                # Basic metadata from search page
                container = link.parent
                if container: container = container.parent
                img = container.css("img::attr(src), img::attr(data-src)").get() if container else None
                
                # Try to get rating if present (using new Tailwind selectors)
                rating = "N/A"
                if container:
                    rating_el = container.css("span.text-amber-400::text, div.numscore::text, span.font-bold::text").get()
                    if rating_el:
                        rating = self.normalize_text(rating_el)
                
                # Try to get status from badge
                status = "Ongoing"
                if container:
                    status_el = container.css("span.bg-emerald-500::text, span.bg-blue-500::text, span.bg-red-500::text, span.bg-secondary-bg::text").get()
                    if status_el:
                        status = self.normalize_status(status_el)

                results.append({
                    "title": title, 
                    "mangaUrl": manga_url, 
                    "cover": self.to_absolute_url(str(img or "")), 
                    "status": status, 
                    "rating": rating, 
                    "source": "ikiru"
                })
            return results
        except: return []

    def get_cookies(self):
        return self.cookies

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query_params = parse_qs(urlparse(self.path).query)
        action = query_params.get('action', [None])[0]
        url = query_params.get('url', [None])[0]
        query = query_params.get('query', [None])[0]
        base_url = query_params.get('baseUrl', ["https://05.ikiru.wtf"])[0]
        max_pages = int(query_params.get('maxPages', [1])[0])
        username = os.environ.get('IKIRU_EMAIL')
        password = os.environ.get('IKIRU_PASSWORD')
        cookies_raw = query_params.get('cookies', [None])[0]
        cookies = json.loads(cookies_raw) if cookies_raw else None
        
        scraper = IkiruScraper(base_url, username, password, cookies)
        result_data = []
        if action == "latest": result_data = scraper.fetch_latest(max_pages)
        elif action == "expand": result_data = scraper.fetch_manga_page(url)
        elif action == "search": result_data = scraper.search(query)
        elif action == "metadata":
            details = scraper.fetch_manga_details(url)
            result_data = details["metadata"]
        
        payload = {
            "data": result_data,
            "_cookies": scraper.get_cookies()
        }
        
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode('utf-8'))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["latest", "expand", "search", "metadata"], required=True)
    parser.add_argument("--url")
    parser.add_argument("--query")
    parser.add_argument("--baseUrl")
    parser.add_argument("--maxPages", type=int, default=1)
    parser.add_argument("--username")
    parser.add_argument("--password")
    parser.add_argument("--cookies", help="JSON string of cookies")
    args = parser.parse_args()
    
    cookies = json.loads(args.cookies) if args.cookies else None
    scraper = IkiruScraper(args.baseUrl or "https://05.ikiru.wtf", args.username, args.password, cookies)
    
    result_data = []
    if args.action == "latest": result_data = scraper.fetch_latest(args.maxPages)
    elif args.action == "expand": result_data = scraper.fetch_manga_page(args.url)
    elif args.action == "search": result_data = scraper.search(args.query)
    elif args.action == "metadata":
        details = scraper.fetch_manga_details(args.url)
        result_data = details["metadata"]
    
    print(json.dumps({
        "data": result_data,
        "_cookies": scraper.get_cookies()
    }))
