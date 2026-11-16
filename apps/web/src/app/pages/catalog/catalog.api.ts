import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AdjustmentRequest,
  CatalogLookups,
  ImportKind,
  ImportPreview,
  ImportResult,
  KardexItem,
  NamedRequest,
  Paginated,
  PartyItem,
  PartyRequest,
  PriceListRequest,
  ProductDetail,
  ProductListItem,
  ProductRequest,
  ProductSearchItem,
  StockItem,
  TransferRequest,
  UnitRequest,
} from '@vektra/shared-contracts';
import { firstValueFrom } from 'rxjs';

type Params = Record<string, string | number | boolean | undefined | null>;
const params = (p: Params) =>
  Object.entries(p).reduce((h, [k, v]) => (v === undefined || v === null || v === '' ? h : h.set(k, String(v))), new HttpParams());

@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly http = inject(HttpClient);
  private lookupsCache: Promise<CatalogLookups> | null = null;

  lookups(refresh = false): Promise<CatalogLookups> {
    if (refresh || !this.lookupsCache) {
      this.lookupsCache = firstValueFrom(this.http.get<CatalogLookups>('/api/catalog/lookups')).catch((e) => {
        this.lookupsCache = null;
        throw e;
      });
    }
    return this.lookupsCache;
  }

  saveCatalog(kind: 'units' | 'categories' | 'brands' | 'price-lists', id: string | null, body: UnitRequest | NamedRequest | PriceListRequest) {
    const req = id ? this.http.patch(`/api/catalog/${kind}/${id}`, body) : this.http.post<{ id: string }>(`/api/catalog/${kind}`, body);
    return firstValueFrom(req).finally(() => (this.lookupsCache = null));
  }

  products = (p: Params) => firstValueFrom(this.http.get<Paginated<ProductListItem>>('/api/products', { params: params(p) }));
  product = (id: string) => firstValueFrom(this.http.get<ProductDetail>(`/api/products/${id}`));
  saveProduct = (id: string | null, body: ProductRequest) =>
    firstValueFrom(id ? this.http.patch(`/api/products/${id}`, body) : this.http.post<{ id: string }>('/api/products', body));
  searchProducts = (q: string, opts: { priceListId?: string; warehouseId?: string } = {}) =>
    firstValueFrom(this.http.get<ProductSearchItem[]>('/api/products/search', { params: params({ q, ...opts }) }));

  parties = (p: Params) => firstValueFrom(this.http.get<Paginated<PartyItem>>('/api/parties', { params: params(p) }));
  partyByIdentification = (id: string) => firstValueFrom(this.http.get<PartyItem | null>(`/api/parties/by-identification/${encodeURIComponent(id)}`));
  saveParty = (id: string | null, body: PartyRequest) =>
    firstValueFrom(id ? this.http.patch(`/api/parties/${id}`, body) : this.http.post<{ id: string }>('/api/parties', body));

  stock = (p: Params) => firstValueFrom(this.http.get<Paginated<StockItem>>('/api/inventory/stock', { params: params(p) }));
  kardex = (productId: string, p: Params) => firstValueFrom(this.http.get<Paginated<KardexItem>>(`/api/inventory/kardex/${productId}`, { params: params(p) }));
  adjust = (body: AdjustmentRequest) => firstValueFrom(this.http.post('/api/inventory/adjustments', body));
  transfer = (body: TransferRequest) => firstValueFrom(this.http.post('/api/inventory/transfers', body));

  template = (kind: ImportKind) => firstValueFrom(this.http.get(`/api/imports/templates/${kind}`, { responseType: 'blob' }));
  previewImport(kind: ImportKind, file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return firstValueFrom(this.http.post<ImportPreview>(`/api/imports/${kind}/preview`, fd));
  }
  commitImport = (id: string) => firstValueFrom(this.http.post<ImportResult>(`/api/imports/${id}/commit`, {}));
  importHistory = () =>
    firstValueFrom(
      this.http.get<{ id: string; kind: ImportKind; status: string; fileName: string; total: number; validCount: number; result: ImportResult | null; createdAt: string }[]>('/api/imports'),
    );
}

/** Precio con IVA a partir del precio sin IVA (y viceversa), para mostrar PVP. */
export const withTax = (net: string | number, rate: string | number) => (Number(net) * (1 + Number(rate) / 100)).toFixed(2);
export const withoutTax = (gross: string | number, rate: string | number) => (Number(gross) / (1 + Number(rate) / 100)).toFixed(6);
