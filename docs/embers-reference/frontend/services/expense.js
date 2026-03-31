import http from './http';

export function all(filters) {
  let url = '/admin/expenses.json?';
  Object.keys(filters).forEach(key => url += `${key}=${filters[key] || ''}&`);
  return http.get({url})
}

export function upsert(model){
  let body = new FormData();

  body.append('entity', model.entity || '' );
  body.append('amount', model.amount || '' );

  if(model.date ){
    body.append('date', model.date || '' );
  }
  if(model.card ){
    body.append('card', model.card || '' );
  }
  if(model.digest ){
    body.append('digest', model.digest || '' );
  }
  if(model.category ){
    body.append('category', model.category || '' );
  }

  if(model.id){ //editar
    return http.put({ url:`/admin/expenses/${model.id}`, body })
  }else{ //criar novo
    return http.post({ url:'/admin/expenses', body })
  }
}

export function show(id){
  return http.get({url:`/admin/expenses/${id}.json`})
}

export function destroy(id){
  return http.delete({url:`/admin/expenses/${id}`})
}

export function undestroy(id){
  return http.put({url:`/admin/expenses/${id}/undestroy`})
}

export function total_expenses(){
  return http.get({url:`/admin/assets/total_expenses`})
}

export function autocomplete_card(term){
  return http.get({url:`admin/expenses/autocomplete_card?term=${encodeURIComponent(term)}`})
}

export function autocomplete_entity(term){
  return http.get({url:`admin/expenses/autocomplete_entity?term=${encodeURIComponent(term)}`})
}

export function autocomplete_category(term){
  return http.get({url:`admin/expenses/autocomplete_category?term=${encodeURIComponent(term)}`})
}

export function get_savings_score(){
  return http.get({url:`admin/expenses/get_user_savings_score`})
}
