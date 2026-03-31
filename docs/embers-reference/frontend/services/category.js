import http from './http';

export function all(filters) {
  let url = '/admin/categories.json?';
  Object.keys(filters).forEach(key => url += `${key}=${filters[key]}&`);
  return http.get({url})
}

export function upsert(model){
  let body = new FormData();

  body.append('name', model.name || '' );

  // Ensure entities is an array
  console.log("Entitites array: " + model.entities); //debug

  // Ensure entities is an array
  // const entities = Array.isArray(model.entities) ? model.entities : [];
  // entities.forEach((entity, index) => {
  //   body.append(`entities[${index}]`, entity);
  // });

  const entities = Array.isArray(model.entities) ? model.entities : [];
  entities.forEach((entity) => {
    body.append('entities[]', entity);
  });

  // Ensure entities[] is appended even if empty
  if (entities.length === 0) {
    body.append('entities[]', '');
  }

  if(model.icon && model.icon.size) {
      body.append('icon', model.icon );
  }

  if(model.id){
    return http.put({ url:`/admin/categories/${model.id}`, body })
  }else{
    return http.post({ url:'/admin/categories', body })
  }
}

export function show(id){
  return http.get({url:`/admin/categories/${id}.json`})
}

export function destroy(id){
  return http.delete({url:`/admin/categories/${id}`})
}
